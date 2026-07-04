import { describe, test, beforeAll, expect } from '@jest/globals';
import { algorandFixture } from '@algorandfoundation/algokit-utils/testing';

import {
  burn,
  burnBatched,
  createLargeVaultPool,
  deployVaultFactory,
  mintLpBatched,
  newProvider,
  provide,
  getBalanceAt,
  provideAndMint,
  swap,
  VaultHarness,
} from './support/vault';

/** Generous timeout: each case deploys many token contracts. */
const SLOW = 600_000;

const fixture = algorandFixture();

/**
 * Stress / limit tests for large pools. These are deliberately slow (they deploy
 * many real token contracts and bootstrap a large pool), so they live in their
 * own file and run with an extended timeout.
 *
 * Investigating "how many tokens fit" surfaced a stack of AVM limits, all now
 * overcome to reach the theoretical maximum of 100 assets:
 *
 *  1. ~15 assets — the ORIGINAL ceiling. The asset list lived in a single global
 *     key (`assets`), and a global entry is capped at 128 bytes (~15 AssetIDs).
 *     FIX: store one box per index (`assetAt`).
 *  2. ~20 assets — single-call bootstrap box-reference limit. Each asset needs
 *     1 opt-in + 3 boxes, and a 16-transaction group exposes only ~120 reference
 *     slots. FIX: batched bootstrap — prepare → addAssets (in batches) → finalize,
 *     so each transaction carries only its own batch's references.
 *  3. opcode budget — topped up inside addAssets.
 *
 * 100 is the hard ceiling: every weight must be >= MIN_WEIGHT (10_000) and the
 * weights must sum to SCALE (1_000_000), so 100 weights of exactly 10_000 is the
 * densest possible. (128 — the old Factory cap — is mathematically impossible right now.)
 *
 * Every stage of the lifecycle is batched to reach 100 assets. A single
 * getLiquidity / burnLiquidity call iterates every asset and so hits the per-group
 * reference limit at ~25 assets (the second test pins that single-call ceiling).
 * The batched path (startMint → commitDeposit → finishMint, and startBurn →
 * claimBurn) splits that O(n) work across many small groups, each within the
 * per-transaction reference budget, so the full seed → swap → burn cycle scales to
 * the maximum 100. swap itself is O(1) (it only touches `from`/`to`).
 *
 * Note on references: box references are NOT shared across a transaction group
 * (unlike assets/accounts), and the per-transaction budget is 8 total references,
 * so each batched call carries only its own boxes/assets — hence the tiny batch
 * sizes (2 for mint, 1 for burn, which also needs the asset itself per transfer).
 */
describe('AssetVault · stress (slow)', () => {
  let harness: VaultHarness;

  beforeAll(async () => {
    await fixture.beforeEach();
    harness = await deployVaultFactory(fixture);
  });

  test(
    'bootstraps a maximum-size 100-asset pool via batched bootstrap',
    async () => {
      const n = 100;
      const pool = await createLargeVaultPool(harness, n);

      expect(await pool.poolClient.getTotalAssets()).toBe(BigInt(n));
      // At 100 assets each weight is exactly MIN_WEIGHT (SCALE / 100 = 10_000).
      expect(await pool.poolClient.getWeight({ args: [0] })).toBe(BigInt(10_000));
      expect(await pool.poolClient.getWeight({ args: [n - 1] })).toBe(BigInt(10_000));
    },
    SLOW
  );

  test(
    'supports the full lifecycle (seed → swap → burn) on a large pool',
    async () => {
      // getLiquidity and burn iterate every asset, so their box references grow
      // with n; the whole lifecycle fits within a 16-transaction group up to ~40.
      const n = 25;
      const pool = await createLargeVaultPool(harness, n);

      // Seed: provide all assets and mint the first LP.
      const lp = await provideAndMint(harness.manager, pool, 100);
      expect(lp).toBeGreaterThan(BigInt(0));

      // Swap is O(1) in the number of assets — it only touches `from` and `to`.
      const trader = await newProvider(harness, pool);
      const received = await swap(trader, pool, 0, 1, 1);
      expect(received).toBeGreaterThan(BigInt(0));

      // Burn iterates every asset; the sole LP redeems the whole pool.
      await burn(harness.manager, pool, lp);
      expect(await pool.poolClient.getBalance({ args: [0] })).toBe(BigInt(0));
    },
    SLOW
  );

  test(
    'supports the full lifecycle at 100 assets via batched mint and burn',
    async () => {
      const n = 100;
      const mid = Math.floor(n / 2);
      const pool = await createLargeVaultPool(harness, n);

      // Seed: escrow every asset (provide), then mint the LP in batches.
      await provide(harness.manager, pool, 100);
      const lp = await mintLpBatched(harness.manager, pool);
      expect(lp).toBeGreaterThan(BigInt(0));
      // Each asset's balance now holds the folded 100 tokens.
      expect(await getBalanceAt(pool, 0)).toBe(BigInt(100_000_000));
      expect(await getBalanceAt(pool, n - 1)).toBe(BigInt(100_000_000));

      // Swap is O(1) — the manager (still holds tokens) trades against the pool.
      const received = await swap(harness.manager, pool, 0, 1, 1);
      expect(received).toBeGreaterThan(BigInt(0));

      // Burn the whole position in batches; the sole LP drains the pool.
      await burnBatched(harness.manager, pool, lp);
      expect(await getBalanceAt(pool, mid)).toBe(BigInt(0));
    },
    SLOW
  );
});
