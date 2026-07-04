import { describe, test, beforeAll, expect } from '@jest/globals';
import { algorandFixture } from '@algorandfoundation/algokit-utils/testing';

import { fixedWeights } from '../helpers/pool';
import { createVaultPool, deployVaultFactory, VaultHarness } from './support/vault';

const fixture = algorandFixture();

/**
 * Pool creation & bootstrap.
 *
 * A vault pool is deployed through the Factory, which seeds its assets and
 * weights and mints the pool's LP token. These tests assert the initial
 * on-chain state right after bootstrap: the LP token exists, every asset is
 * registered with its weight, and all balances start at zero (no liquidity yet).
 */
describe('AssetVault · bootstrap', () => {
  let harness: VaultHarness;

  beforeAll(async () => {
    await fixture.beforeEach();
    harness = await deployVaultFactory(fixture);
  });

  test('a freshly bootstrapped 50/50 pool has an LP token, two assets and zero balances', async () => {
    const pool = await createVaultPool(harness, [0.5, 0.5]);
    const { poolClient, lpId } = pool;

    // LP token was created and matches what initPool reported.
    expect(lpId).toBeGreaterThan(BigInt(0));
    expect(await poolClient.getToken()).toBe(lpId);

    // Two assets, registered with the requested weights.
    expect(await poolClient.getTotalAssets()).toBe(BigInt(2));
    expect(await poolClient.getWeight({ args: [0] })).toBe(fixedWeights([0.5])[0]);
    expect(await poolClient.getWeight({ args: [1] })).toBe(fixedWeights([0.5])[0]);

    // No liquidity provided yet → both balances are zero.
    expect(await poolClient.getBalance({ args: [0] })).toBe(BigInt(0));
    expect(await poolClient.getBalance({ args: [1] })).toBe(BigInt(0));
  });

  test('a 80/20 pool stores the asymmetric weights', async () => {
    const pool = await createVaultPool(harness, [0.8, 0.2]);
    const { poolClient } = pool;

    expect(await poolClient.getWeight({ args: [0] })).toBe(fixedWeights([0.8])[0]);
    expect(await poolClient.getWeight({ args: [1] })).toBe(fixedWeights([0.2])[0]);
  });

  test('a weight below MIN_WEIGHT is rejected', async () => {
    // 0.005 → 5_000 micro, under the 10_000 floor.
    await expect(createVaultPool(harness, [0.995, 0.005])).rejects.toThrow();
  });

  test('a weight exactly at MIN_WEIGHT is accepted', async () => {
    // 0.01 → 10_000 micro, the floor itself (the `>=` boundary must pass).
    const pool = await createVaultPool(harness, [0.99, 0.01]);
    expect(await pool.poolClient.getWeight({ args: [1] })).toBe(BigInt(10_000));
  });

  test('a 3-asset pool bootstraps with the requested weights', async () => {
    const pool = await createVaultPool(harness, [0.5, 0.3, 0.2]);

    expect(await pool.poolClient.getTotalAssets()).toBe(BigInt(3));
    expect(await pool.poolClient.getWeight({ args: [0] })).toBe(fixedWeights([0.5])[0]);
    expect(await pool.poolClient.getWeight({ args: [1] })).toBe(fixedWeights([0.3])[0]);
    expect(await pool.poolClient.getWeight({ args: [2] })).toBe(fixedWeights([0.2])[0]);
  });
});
