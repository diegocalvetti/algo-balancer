import { describe, test, beforeAll, beforeEach, expect } from '@jest/globals';
import { algorandFixture } from '@algorandfoundation/algokit-utils/testing';

import { fixedWeights } from '../helpers/pool';
import {
  advanceRounds,
  changeWeights,
  createVaultPool,
  currentWeights,
  deployVaultFactory,
  newProvider,
  poolTimes,
  provide,
  provideAndMint,
  storedWeights,
  swap,
  VaultHarness,
  VaultPool,
} from './support/vault';

const ZERO = BigInt(0);

/** Off-chain mirror of the contract's getCurrentWeight interpolation. */
function expectedWeight(w0: bigint, w1: bigint, start: bigint, end: bigint, current: bigint): bigint {
  if (current <= start || start === ZERO || end === ZERO) return w0;
  if (current >= end) return w1;

  const elapsed = current - start;
  const total = end - start;
  const delta = w1 > w0 ? w1 - w0 : w0 - w1;
  const offset = (delta * elapsed) / total; // wideRatio truncates → integer division

  return w1 > w0 ? w0 + offset : w0 - offset;
}

const fixture = algorandFixture();

/**
 * Dynamic weights.
 *
 * The manager can re-weight the pool either instantly or via a linear
 * interpolation over a block window (startRound → endRound): getCurrentWeight
 * reports the live interpolated value, while the stored weights only finalize on
 * the next state-changing call. These tests cover the instant change, the linear
 * interpolation (checked against an off-chain mirror), finalization past the end,
 * the no-concurrent-transition rule, and manager-only access control.
 */
describe('AssetVault · weights', () => {
  let harness: VaultHarness;

  beforeAll(async () => {
    await fixture.beforeEach();
    harness = await deployVaultFactory(fixture);
  });

  // Fresh 80/20 pool per scenario.
  let pool: VaultPool;
  const W0 = fixedWeights([0.8, 0.2]); // [800000, 200000]
  beforeEach(async () => {
    pool = await createVaultPool(harness, [0.8, 0.2]);
  });

  test('an instant change (duration 0) applies the new weights immediately', async () => {
    await changeWeights(harness.manager, pool, [0.3, 0.7], 0);

    const target = fixedWeights([0.3, 0.7]);
    expect(await currentWeights(pool)).toStrictEqual(target);
    expect(await storedWeights(pool)).toStrictEqual(target);

    // No transition window is opened.
    const { start, end } = await poolTimes(pool);
    expect(start).toBe(ZERO);
    expect(end).toBe(ZERO);
  });

  test('a timed change interpolates linearly between the old and new weights', async () => {
    await changeWeights(harness.manager, pool, [0.5, 0.5], 20);
    await advanceRounds(harness.manager, pool, 5);

    const { start, end, current } = await poolTimes(pool);
    // Sanity: we are mid-transition.
    expect(current).toBeGreaterThan(start);
    expect(current).toBeLessThan(end);

    const target = fixedWeights([0.5, 0.5]);
    const live = await currentWeights(pool);

    // Each live weight matches the linear interpolation for this exact round.
    expect(live[0]).toBe(expectedWeight(W0[0], target[0], start, end, current));
    expect(live[1]).toBe(expectedWeight(W0[1], target[1], start, end, current));

    // Asset 0 is decreasing (0.8 → 0.5), so it sits strictly between the two.
    expect(live[0]).toBeLessThan(W0[0]);
    expect(live[0]).toBeGreaterThan(target[0]);
  });

  test('past the end the weights reach the target and finalize on the next state change', async () => {
    await changeWeights(harness.manager, pool, [0.5, 0.5], 3);
    await advanceRounds(harness.manager, pool, 5); // past end

    const target = fixedWeights([0.5, 0.5]);

    // getCurrentWeight already reports the target...
    expect(await currentWeights(pool)).toStrictEqual(target);
    // ...but the stored weights only finalize when a state-changing call runs.
    const { start, end } = await poolTimes(pool);
    expect(start).not.toBe(ZERO);

    // Any liquidity op triggers tryFinalizeWeights.
    await provide(harness.manager, pool, 1, [0]);

    expect(await storedWeights(pool)).toStrictEqual(target);
    const after = await poolTimes(pool);
    expect(after.start).toBe(ZERO);
    expect(after.end).toBe(ZERO);
  });

  test('a second change while a transition is in progress is rejected', async () => {
    await changeWeights(harness.manager, pool, [0.5, 0.5], 20);

    await expect(changeWeights(harness.manager, pool, [0.6, 0.4], 20)).rejects.toThrow();
  });

  test('only the manager can change weights', async () => {
    const stranger = await newProvider(harness, pool);

    await expect(changeWeights(stranger, pool, [0.5, 0.5], 0)).rejects.toThrow();
  });

  test('a swap during a weight transition prices at the interpolated weights', async () => {
    // A 0→1 swap of the same size on three pools: static 0.8/0.2, a pool halfway
    // through shifting 0.8/0.2 → 0.5/0.5, and static 0.5/0.5. Output falls as the
    // weight ratio w0/w1 drops from 4 to 1, so the live (interpolated) pool must
    // land strictly between the two static endpoints.
    const poolStatic = await createVaultPool(harness, [0.8, 0.2]);
    await provideAndMint(harness.manager, poolStatic, 1000);
    const outStatic = await swap(await newProvider(harness, poolStatic), poolStatic, 0, 1, 1);

    const poolMid = await createVaultPool(harness, [0.8, 0.2]);
    await provideAndMint(harness.manager, poolMid, 1000);
    await changeWeights(harness.manager, poolMid, [0.5, 0.5], 20);
    await advanceRounds(harness.manager, poolMid, 10);
    const outMid = await swap(await newProvider(harness, poolMid), poolMid, 0, 1, 1);

    const poolTarget = await createVaultPool(harness, [0.5, 0.5]);
    await provideAndMint(harness.manager, poolTarget, 1000);
    const outTarget = await swap(await newProvider(harness, poolTarget), poolTarget, 0, 1, 1);

    expect(outMid).toBeLessThan(outStatic);
    expect(outMid).toBeGreaterThan(outTarget);
  });

  test('a new weight change can start once the previous one finalizes', async () => {
    const livePool = await createVaultPool(harness, [0.8, 0.2]);
    await provideAndMint(harness.manager, livePool, 1000);
    const trader = await newProvider(harness, livePool);

    await changeWeights(harness.manager, livePool, [0.5, 0.5], 3);
    await advanceRounds(harness.manager, livePool, 5); // window elapsed
    await swap(trader, livePool, 0, 1, 1); // any op finalizes the transition

    // The transition window is cleared, so a fresh change is accepted.
    await changeWeights(harness.manager, livePool, [0.6, 0.4], 0);
    expect(await livePool.poolClient.getWeight({ args: [0] })).toBe(fixedWeights([0.6])[0]);
  });
});
