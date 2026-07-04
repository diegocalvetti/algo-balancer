import { describe, test, beforeAll, beforeEach, expect } from '@jest/globals';
import { algorandFixture } from '@algorandfoundation/algokit-utils/testing';

import {
  assetBalance,
  burn,
  cancelDeposit,
  createVaultPool,
  deployVaultFactory,
  newProvider,
  poolBalances,
  provide,
  provideAndMint,
  VaultHarness,
  VaultPool,
} from './support/vault';

const TOKEN = BigInt(1_000_000);

const fixture = algorandFixture();

/**
 * Pending (not-yet-minted) liquidity.
 *
 * addLiquidity and getLiquidity are separate transactions. A deposit is escrowed
 * in `provided` and only folded into the shared pool `balances` when getLiquidity
 * mints the matching LP. These tests check that a still-pending deposit is safe
 * from other LPs, refundable, and does not affect the price in the meantime.
 */
describe('AssetVault · pending liquidity', () => {
  let harness: VaultHarness;

  beforeAll(async () => {
    await fixture.beforeEach();
    harness = await deployVaultFactory(fixture);
  });

  // Manager seeds 1000 of each and is the sole LP before every scenario.
  let pool: VaultPool;
  let managerLp: bigint;
  beforeEach(async () => {
    pool = await createVaultPool(harness, [0.5, 0.5]);
    managerLp = await provideAndMint(harness.manager, pool, 1000);
  });

  test('a pending deposit is not withdrawable by an existing LP', async () => {
    // Alice escrows 100 of each but does not mint — her funds are pending.
    const alice = await newProvider(harness, pool);
    await provide(alice, pool, 100);

    // The manager (sole LP, deposited 1000) burns all of his LP.
    const before = await assetBalance(harness.manager, pool.assetIds[0]);
    await burn(harness.manager, pool, managerLp);
    const redeemed = (await assetBalance(harness.manager, pool.assetIds[0])) - before;

    // He reclaims only his own ~1000, never Alice's pending 100.
    expect(redeemed).toBeLessThanOrEqual(BigInt(1000) * TOKEN + TOKEN);
  });

  test('a pending deposit can be reclaimed with cancelDeposit', async () => {
    const alice = await newProvider(harness, pool);
    const before0 = await assetBalance(alice, pool.assetIds[0]);
    const before1 = await assetBalance(alice, pool.assetIds[1]);

    await provide(alice, pool, 100);

    // Even if the sole LP drains the pool in the meantime, the escrow is untouched.
    await burn(harness.manager, pool, managerLp);
    await cancelDeposit(alice, pool);

    expect(await assetBalance(alice, pool.assetIds[0])).toBe(before0);
    expect(await assetBalance(alice, pool.assetIds[1])).toBe(before1);
  });

  test('a pending deposit does not move the pool balances (and so the price)', async () => {
    const before = await poolBalances(pool);

    // Alice escrows a large single-asset deposit that would skew a 50/50 pool.
    const alice = await newProvider(harness, pool);
    await provide(alice, pool, 500, [0]);

    // Escrow is not part of `balances`, so nothing that prices swaps has changed.
    expect(await poolBalances(pool)).toEqual(before);
  });

  test("two providers' pending deposits are independent", async () => {
    const alice = await newProvider(harness, pool);
    const bob = await newProvider(harness, pool);
    const bobBefore = await assetBalance(bob, pool.assetIds[0]);

    await provide(bob, pool, 200); // bob escrows 200 (not minted)
    await provideAndMint(alice, pool, 100); // alice deposits and mints

    // Alice's mint did not consume bob's escrow: he recovers exactly his 200.
    await cancelDeposit(bob, pool);
    expect(await assetBalance(bob, pool.assetIds[0])).toBe(bobBefore);
  });

  test('cancelDeposit refunds only the assets that were escrowed', async () => {
    const alice = await newProvider(harness, pool);
    const before0 = await assetBalance(alice, pool.assetIds[0]);
    const before1 = await assetBalance(alice, pool.assetIds[1]);

    await provide(alice, pool, 100, [0]); // escrow asset 0 only

    await cancelDeposit(alice, pool);
    expect(await assetBalance(alice, pool.assetIds[0])).toBe(before0); // refunded
    expect(await assetBalance(alice, pool.assetIds[1])).toBe(before1); // never touched
  });
});
