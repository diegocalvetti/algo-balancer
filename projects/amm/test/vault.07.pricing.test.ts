import { describe, test, beforeAll, expect } from '@jest/globals';
import { algorandFixture } from '@algorandfoundation/algokit-utils/testing';

import { createVaultPool, deployVaultFactory, newProvider, provideAndMint, swap, VaultHarness } from './support/vault';

/**
 * Off-chain reference for the weighted constant-mean swap output (Balancer):
 *
 *   amountOut = balanceOut * (1 - (balanceIn / (balanceIn + amountIn·(1-fee)))^(weightIn/weightOut))
 *
 * All amounts in whole tokens. Used to check that the on-chain fixed-point math
 * reproduces the analytic price, and that weights actually shape it.
 */
function balancerOut(
  balanceIn: number,
  weightIn: number,
  balanceOut: number,
  weightOut: number,
  amountIn: number
): number {
  const fee = 0.001;
  const amountInWithFee = amountIn * (1 - fee);
  const ratio = balanceIn / (balanceIn + amountInWithFee);
  return balanceOut * (1 - ratio ** (weightIn / weightOut));
}

const fixture = algorandFixture();

/**
 * Weighted pricing.
 *
 * Verifies the swap output against the analytic Balancer formula, and that the
 * weights genuinely enter the price: on an 80/20 pool a small trade out of the
 * heavy asset yields far more than one out of the light asset (~4x vs ~0.25x),
 * something a weight-blind implementation could never reproduce.
 */
describe('AssetVault · pricing', () => {
  let harness: VaultHarness;

  beforeAll(async () => {
    await fixture.beforeEach();
    harness = await deployVaultFactory(fixture);
  });

  test('a 50/50 pool matches the analytic Balancer output', async () => {
    const pool = await createVaultPool(harness, [0.5, 0.5]);
    await provideAndMint(harness.manager, pool, 1000);
    const trader = await newProvider(harness, pool);

    const received = Number(await swap(trader, pool, 0, 1, 10)) / 10 ** 6;
    const expected = balancerOut(1000, 0.5, 1000, 0.5, 10);

    expect(received).toBeCloseTo(expected, 1); // within 0.05 token
  });

  test('an 80/20 pool prices out of the heavy asset by the weight ratio (~4x)', async () => {
    const pool = await createVaultPool(harness, [0.8, 0.2]);
    await provideAndMint(harness.manager, pool, 1000);
    const trader = await newProvider(harness, pool);

    // asset 0 (weight 0.8) → asset 1 (weight 0.2): output scaled by w0/w1 = 4.
    const received = Number(await swap(trader, pool, 0, 1, 1)) / 10 ** 6;
    const expected = balancerOut(1000, 0.8, 1000, 0.2, 1);

    expect(received).toBeCloseTo(expected, 1);
    expect(received).toBeGreaterThan(3); // weights matter: a 50/50 pool would give ~1
  });

  test('an 80/20 pool prices out of the light asset by the inverse ratio (~0.25x)', async () => {
    const pool = await createVaultPool(harness, [0.8, 0.2]);
    await provideAndMint(harness.manager, pool, 1000);
    const trader = await newProvider(harness, pool);

    // asset 1 (weight 0.2) → asset 0 (weight 0.8): output scaled by w1/w0 = 0.25.
    const received = Number(await swap(trader, pool, 1, 0, 1)) / 10 ** 6;
    const expected = balancerOut(1000, 0.2, 1000, 0.8, 1);

    expect(received).toBeCloseTo(expected, 1);
    expect(received).toBeLessThan(1); // markedly cheaper than the reverse direction
  });
});
