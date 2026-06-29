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
  storedWeights,
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
});
