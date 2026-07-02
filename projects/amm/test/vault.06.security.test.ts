import { describe, test, beforeAll, beforeEach, expect } from '@jest/globals';
import { algorandFixture } from '@algorandfoundation/algokit-utils/testing';

import { commonAppCallTxParams, makeAssetTransferTxn } from '../helpers/generic';
import {
  createVaultPool,
  deployVaultFactory,
  newProvider,
  provideAndMint,
  vaultClientFor,
  VaultHarness,
  VaultPool,
} from './support/vault';

const fixture = algorandFixture();

/**
 * Adversarial tests: the pool must never trust the asset transfer handed to a
 * method. Each core operation validates that the incoming transfer carries the
 * expected asset and is actually sent to the pool; otherwise an attacker could
 * pay in a worthless (or wrong) asset and still receive value. These tests build
 * malformed transfers directly and assert the call reverts.
 */
describe('AssetVault · security', () => {
  let harness: VaultHarness;

  beforeAll(async () => {
    await fixture.beforeEach();
    harness = await deployVaultFactory(fixture);
  });

  // Fresh 50/50 pool seeded with 1000 of each asset before each attack.
  let pool: VaultPool;
  beforeEach(async () => {
    pool = await createVaultPool(harness, [0.5, 0.5]);
    await provideAndMint(harness.manager, pool, 1000);
  });

  test('swap rejects an input asset that does not match the `from` index', async () => {
    const attacker = await newProvider(harness, pool);
    const client = vaultClientFor(attacker, pool);

    // Send asset 1 into the pool but claim to be swapping from index 0.
    const badTransfer = await makeAssetTransferTxn(attacker, pool.assetIds[1], pool.poolClient.appAddress, 10);

    const group = client.newGroup();
    group.opUp({ ...commonAppCallTxParams(attacker), args: [], note: new Uint8Array([0]) });
    group.swap({ ...commonAppCallTxParams(attacker, (500_000).microAlgo()), args: [0, 1, 0, badTransfer] });

    await expect(group.send({ populateAppCallResources: true, coverAppCallInnerTransactionFees: true })).rejects.toThrow();
  });

  test('swap rejects input that is not sent to the pool', async () => {
    const attacker = await newProvider(harness, pool);
    const client = vaultClientFor(attacker, pool);

    // Correct asset, but the transfer pays the attacker instead of the pool.
    const badTransfer = await makeAssetTransferTxn(attacker, pool.assetIds[0], attacker.sender, 10);

    const group = client.newGroup();
    group.opUp({ ...commonAppCallTxParams(attacker), args: [], note: new Uint8Array([0]) });
    group.swap({ ...commonAppCallTxParams(attacker, (500_000).microAlgo()), args: [0, 1, 0, badTransfer] });

    await expect(group.send({ populateAppCallResources: true, coverAppCallInnerTransactionFees: true })).rejects.toThrow();
  });

  test('addLiquidity rejects an asset that does not match the index', async () => {
    const attacker = await newProvider(harness, pool);
    const client = vaultClientFor(attacker, pool);

    // Deposit asset 1 while declaring index 0.
    const badTransfer = await makeAssetTransferTxn(attacker, pool.assetIds[1], pool.poolClient.appAddress, 10);

    await expect(
      client.send.addLiquidity({
        ...commonAppCallTxParams(attacker, (500_000).microAlgo()),
        args: [0, badTransfer],
      })
    ).rejects.toThrow();
  });

  test('burnLiquidity rejects a non-LP asset', async () => {
    const attacker = await newProvider(harness, pool);
    const client = vaultClientFor(attacker, pool);

    // Send a pool asset (not the LP token) and try to redeem against it.
    const badTransfer = await makeAssetTransferTxn(attacker, pool.assetIds[0], pool.poolClient.appAddress, 10);

    const group = client.newGroup();
    group.opUp({ ...commonAppCallTxParams(attacker), args: [], note: new Uint8Array([0]) });
    group.burnLiquidity({ ...commonAppCallTxParams(attacker, (500_000).microAlgo()), args: [badTransfer] });

    await expect(group.send({ populateAppCallResources: true, coverAppCallInnerTransactionFees: true })).rejects.toThrow();
  });
});
