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
 * Investigating "how many tokens fit" surfaced a stack of AVM limits, from the
 * binding one outward:
 *
 *  1. ~15 assets — the real ceiling. The pool stores its asset list in a single
 *     global-state key (`assets`), and a global entry is capped at 128 bytes:
 *     key 'assets' (6) + AssetID[] (8·n + 2) <= 128  =>  n <= 15. The 16th asset
 *     fails the global write with "value too long".
 *  2. ~30 assets — box-reference resources (2 boxes + 1 asset opt-in per token vs
 *     the ~120 reference slots in a 16-transaction group). Masked by limit 1.
 *  3. opcode budget — handled by topping up inside bootstrap.
 *  4. 100 (bootstrap) / 128 (old Factory) — assertions in the code that are never
 *     reached; 128 is also mathematically impossible (128 * MIN_WEIGHT > SCALE).
 *
 * Reaching hundreds of assets would require storing `assets` in a BoxMap instead
 * of one global key — a deliberate future refactor.
 */
describe('AssetVault · stress (slow)', () => {
  let harness: VaultHarness;

  beforeAll(async () => {
    await fixture.beforeEach();
    harness = await deployVaultFactory(fixture);
  });

  test(
    'bootstraps a 15-asset pool (the practical maximum for the global asset array)',
    async () => {
      const n = 15;
      const pool = await createLargeVaultPool(harness, n);

      expect(await pool.poolClient.getTotalAssets()).toBe(BigInt(n));
      // Non-first assets carry the base weight floor(SCALE / n).
      expect(await pool.poolClient.getWeight({ args: [n - 1] })).toBe(BigInt(Math.floor(10 ** 6 / n)));
    },
    SLOW
  );
});
