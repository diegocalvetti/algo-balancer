import { describe, test, beforeAll, beforeEach, expect } from '@jest/globals';
import { algorandFixture } from '@algorandfoundation/algokit-utils/testing';

import {
  assetBalance,
  burn,
  createVaultPool,
  deployVaultFactory,
  newProvider,
  poolInvariant,
  provideAndMint,
  swap,
  VaultHarness,
  VaultPool,
} from './support/vault';

const ONE_TOKEN = BigInt(1_000_000);
const ZERO = BigInt(0);

const fixture = algorandFixture();

/**
 * Economic / value-conservation properties of the vault.
 *
 * Unlike the bound-checking unit tests, these exercise realistic flows and assert
 * the invariants that make an AMM sound: a trader can never round-trip at a
 * profit, swaps only ever grow the pool invariant (fees stay in), depositing then
 * immediately burning never returns more than was put in, and trading fees accrue
 * to liquidity providers. Fixed-point math leaves dust, so amounts are checked
 * with tolerances and directional bounds rather than equalities.
 */
describe('AssetVault · economics', () => {
  let harness: VaultHarness;

  beforeAll(async () => {
    await fixture.beforeEach();
    harness = await deployVaultFactory(fixture);
  });

  // Fresh 50/50 pool seeded with 1000 of each asset before every scenario.
  let pool: VaultPool;
  beforeEach(async () => {
    pool = await createVaultPool(harness, [0.5, 0.5]);
    await provideAndMint(harness.manager, pool, 1000);
  });

  test('a swap round-trip never profits the trader', async () => {
    const trader = await newProvider(harness, pool);

    const before = await assetBalance(trader, pool.assetIds[0]);

    // 50 of asset 0 → asset 1, then all of it straight back.
    const received = await swap(trader, pool, 0, 1, 50);
    await swap(trader, pool, 1, 0, Number(received) / 10 ** 6);

    const after = await assetBalance(trader, pool.assetIds[0]);

    // Strictly worse off (paid the fee twice) — no value extracted from the pool.
    expect(after).toBeLessThan(before);
    // ...but only by fees + slippage, not catastrophically (< 1 token on a 50 trade).
    expect(before - after).toBeLessThan(ONE_TOKEN);
  });

  test('a swap grows the pool invariant (value never leaks out)', async () => {
    const trader = await newProvider(harness, pool);

    const vBefore = await poolInvariant(pool);
    await swap(trader, pool, 0, 1, 50);
    const vAfter = await poolInvariant(pool);

    // The fee stays in the pool, so the weighted invariant strictly grows.
    expect(vAfter).toBeGreaterThan(vBefore);
  });

  test('depositing then immediately burning returns no more than was deposited', async () => {
    const lp = await newProvider(harness, pool);

    const before0 = await assetBalance(lp, pool.assetIds[0]);
    const before1 = await assetBalance(lp, pool.assetIds[1]);

    // Add 300 of each to a 1000/1000 pool → growth ratio 0.3 (exercises pow(0.3, w),
    // i.e. a non-trivial fixed-point power, unlike the exact 1:1 unit ratio).
    const minted = await provideAndMint(lp, pool, 300);
    await burn(lp, pool, minted);

    const after0 = await assetBalance(lp, pool.assetIds[0]);
    const after1 = await assetBalance(lp, pool.assetIds[1]);

    // Net flow into the pool is non-negative on both assets: the LP cannot extract
    // value by minting then burning (would expose pow over-minting).
    expect(before0 - after0).toBeGreaterThanOrEqual(ZERO);
    expect(before1 - after1).toBeGreaterThanOrEqual(ZERO);
    // And only dust is lost (the position is recovered almost exactly).
    expect(before0 - after0).toBeLessThan(ONE_TOKEN);
    expect(before1 - after1).toBeLessThan(ONE_TOKEN);
  });

  test('trading fees accrue to liquidity providers', async () => {
    // The manager seeded the pool in beforeEach and is the sole LP, so any growth
    // of the invariant is value they can redeem by burning.
    const vSeed = await poolInvariant(pool);

    const trader = await newProvider(harness, pool);
    for (let i = 0; i < 5; i += 1) {
      const received = await swap(trader, pool, 0, 1, 50);
      await swap(trader, pool, 1, 0, Number(received) / 10 ** 6);
    }

    const vAfter = await poolInvariant(pool);

    // Volume left fees behind: the LP-owned pool is worth more than it was seeded.
    expect(vAfter).toBeGreaterThan(vSeed);
  });

  test('two equal providers receive equal LP and redeem equally', async () => {
    const alice = await newProvider(harness, pool);
    const bob = await newProvider(harness, pool);

    const lpA = await provideAndMint(alice, pool, 100);
    const lpB = await provideAndMint(bob, pool, 100);
    // Equal value added → equal LP, within integer-rounding dust.
    const lpDiff = lpA > lpB ? lpA - lpB : lpB - lpA;
    expect(lpDiff).toBeLessThan(ONE_TOKEN);

    const aBefore = await assetBalance(alice, pool.assetIds[0]);
    await burn(alice, pool, lpA);
    const aRedeemed = (await assetBalance(alice, pool.assetIds[0])) - aBefore;

    const bBefore = await assetBalance(bob, pool.assetIds[0]);
    await burn(bob, pool, lpB);
    const bRedeemed = (await assetBalance(bob, pool.assetIds[0])) - bBefore;

    // Each recovers its ~100-token deposit, and the two shares match.
    const redeemedDiff = aRedeemed > bRedeemed ? aRedeemed - bRedeemed : bRedeemed - aRedeemed;
    expect(redeemedDiff).toBeLessThan(ONE_TOKEN);
    expect(aRedeemed).toBeGreaterThan(BigInt(99) * ONE_TOKEN);
  });

  test('a small proportional deposit is minted and redeemed without leak', async () => {
    const lp = await newProvider(harness, pool);
    const before0 = await assetBalance(lp, pool.assetIds[0]);

    // Add 50 to a 1000 pool → growth ratio 0.05, far below 1.
    const minted = await provideAndMint(lp, pool, 50);
    await burn(lp, pool, minted);

    const net = before0 - (await assetBalance(lp, pool.assetIds[0]));
    expect(net).toBeGreaterThanOrEqual(BigInt(0)); // no value extracted
    expect(net).toBeLessThan(ONE_TOKEN); // only dust lost
  });
});
