import { describe, test, beforeAll, beforeEach, expect } from '@jest/globals';
import { algorandFixture } from '@algorandfoundation/algokit-utils/testing';

import {
  createVaultPool,
  deployVaultFactory,
  newProvider,
  provideAndMint,
  swap,
  VaultHarness,
  VaultPool,
} from './support/vault';

/** Whole tokens of each asset the manager seeds the pool with before swaps. */
const SEED = 1000;
const SEED_MICRO = BigInt(SEED * 10 ** 6);

const fixture = algorandFixture();

describe('AssetVault · swap', () => {
  let harness: VaultHarness;

  beforeAll(async () => {
    await fixture.beforeEach();
    harness = await deployVaultFactory(fixture);
  });

  // Fresh 50/50 pool seeded with equal balances before each swap scenario.
  let pool: VaultPool;
  beforeEach(async () => {
    pool = await createVaultPool(harness, [0.5, 0.5]);
    await provideAndMint(harness.manager, pool, SEED);
  });

  test('a normal swap returns a positive output smaller than the input', async () => {
    const trader = await newProvider(harness, pool);
    const amountIn = 10;
    const received = await swap(trader, pool, 0, 1, amountIn);

    // On a balanced 50/50 pool the price is ~1, so output is positive but below
    // the input (fee + slippage).
    expect(received).toBeGreaterThan(BigInt(0));
    expect(received).toBeLessThan(BigInt(amountIn * 10 ** 6));
  });

  test('a negligible input rounds the output down to zero', async () => {
    const trader = await newProvider(harness, pool);
    // 1 micro in: after the 0.1% fee the effective input truncates to 0.
    const received = await swap(trader, pool, 0, 1, 0.000001);

    expect(received).toBe(BigInt(0));
  });

  test('the input asset balance grows by exactly the amount swapped in', async () => {
    const trader = await newProvider(harness, pool);
    const amountIn = 25;

    const received = await swap(trader, pool, 0, 1, amountIn);

    // Asset in: balance += full amountIn (fee stays in the pool).
    expect(await pool.poolClient.getBalance({ args: [0] })).toBe(SEED_MICRO + BigInt(amountIn * 10 ** 6));
    // Asset out: balance -= exactly what the trader received.
    expect(await pool.poolClient.getBalance({ args: [1] })).toBe(SEED_MICRO - received);
  });

  test('a huge input takes most of the output asset but never exceeds its balance', async () => {
    const trader = await newProvider(harness, pool);
    // Swap far more than the pool holds.
    const received = await swap(trader, pool, 0, 1, 10_000_000);

    // Safety invariant: the pool can never pay out more than it holds.
    expect(received).toBeLessThan(SEED_MICRO);
    // A huge swap still drains the majority of the output balance. It undershoots
    // a perfect drain because the on-chain fixed-point pow loses precision for
    // extreme ratios — conservatively, so the pool never over-pays.
    expect(received).toBeGreaterThan(SEED_MICRO / BigInt(2));
  });

  test('a swap respects the minOut slippage guard', async () => {
    const trader = await newProvider(harness, pool);
    // Demand an absurdly high minimum output → must revert.
    await expect(swap(trader, pool, 0, 1, 10, Number(SEED_MICRO))).rejects.toThrow();
  });
});
