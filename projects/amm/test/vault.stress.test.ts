import { describe, test, beforeAll, expect } from '@jest/globals';
import { algorandFixture } from '@algorandfoundation/algokit-utils/testing';

import { createLargeVaultPool, deployVaultFactory, VaultHarness } from './support/vault';

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
 * densest possible. (128 — the old Factory cap — is mathematically impossible.)
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
});
