import { describe, test, beforeAll, beforeEach, expect } from '@jest/globals';
import { algorandFixture } from '@algorandfoundation/algokit-utils/testing';

import {
  burn,
  createVaultPool,
  deployVaultFactory,
  newProvider,
  provide,
  provideAndMint,
  mintLp,
  VaultHarness,
  VaultPool,
} from './support/vault';

/** Fixed amount minted to the very first liquidity provider (1e6 LP, 6 decimals). */
const AMOUNT_LP_DEPLOYER = BigInt(1_000_000 * 10 ** 6);

const fixture = algorandFixture();

/**
 * Liquidity provision & redemption.
 *
 * Providers deposit assets in proportion to the pool's current balances (an
 * invariant-preserving join) and receive LP tokens via the weighted
 * geometric-mean formula; burning LP redeems the underlying assets pro-rata.
 * These tests cover proportional minting across providers, rejection of
 * unbalanced/single-sided deposits, the rule that the first deposit must seed
 * every asset, and burn draining the pool.
 */
describe('AssetVault · liquidity', () => {
  let harness: VaultHarness;

  beforeAll(async () => {
    await fixture.beforeEach();
    harness = await deployVaultFactory(fixture);
  });

  // Each scenario gets its own fresh pool — no inherited balances.
  let pool: VaultPool;
  beforeEach(async () => {
    pool = await createVaultPool(harness, [0.5, 0.5]);
  });

  test('the first provider receives the fixed deployer LP amount', async () => {
    const lp = await provideAndMint(harness.manager, pool, 1);
    expect(lp).toBe(AMOUNT_LP_DEPLOYER);
  });

  test('the first deposit must seed every asset', async () => {
    // Seed only asset 0 as the very first deposit → leaves asset 1 at zero.
    await provide(harness.manager, pool, 1, [0]);
    await expect(mintLp(harness.manager, pool)).rejects.toThrow();
  });

  test('LP minted is proportional across providers', async () => {
    // 1st provider (manager): seeds the pool, gets the fixed deployer amount.
    const lp1 = await provideAndMint(harness.manager, pool, 1);

    // 2nd provider: same deposit as the 1st → same LP.
    const bob = await newProvider(harness, pool);
    const lp2 = await provideAndMint(bob, pool, 1);

    // 3rd provider: double the deposit → double the LP of the 2nd.
    const carol = await newProvider(harness, pool);
    const lp3 = await provideAndMint(carol, pool, 2);

    expect(lp2).toBe(lp1);
    expect(lp3).toBe(BigInt(2) * lp2);
  });

  // A single-sided (or otherwise unbalanced) deposit is not invariant-preserving,
  // so the geometric-mean LP formula would misprice it. The contract rejects it
  // instead of silently minting wrong/zero LP. The already-deposited asset stays
  // in the provider's `provided` box and can be recovered by completing the
  // deposit proportionally — it is not lost.
  test('single-sided provision is rejected (must be proportional)', async () => {
    // Seed the pool first so balances are non-zero.
    await provideAndMint(harness.manager, pool, 1);

    const dave = await newProvider(harness, pool);
    await provide(dave, pool, 1, [0]); // only asset 0 → unbalanced

    await expect(mintLp(dave, pool)).rejects.toThrow();
  });

  test('burning LP returns the underlying assets and drains the pool', async () => {
    // Sole provider seeds 1 token of each asset.
    const lp = await provideAndMint(harness.manager, pool, 1);
    expect(await pool.poolClient.getBalance({ args: [0] })).toBe(BigInt(1_000_000));
    expect(await pool.poolClient.getBalance({ args: [1] })).toBe(BigInt(1_000_000));

    // Burning the entire supply redeems the full pool balance.
    await burn(harness.manager, pool, lp);

    expect(await pool.poolClient.getBalance({ args: [0] })).toBe(BigInt(0));
    expect(await pool.poolClient.getBalance({ args: [1] })).toBe(BigInt(0));
  });
});
