/* eslint-disable no-console */
import { describe, test, beforeAll, beforeEach, expect } from '@jest/globals';
import { Config } from '@algorandfoundation/algokit-utils';
import { algorandFixture } from '@algorandfoundation/algokit-utils/testing';

import { TransactionSigner } from 'algosdk';
import { FactoryClient } from '../contracts/clients/FactoryClient';
import { createAndMintToken } from '../helpers/token';
import { changeWeights, deployAndInitPool, getCurrentWeight, getInterpolationTimeLeft, getPool } from '../helpers/pool';
import { AssetInfo, getRandomAccount, pay, retrieveResult, sleep } from '../helpers/generic';

const fixture = algorandFixture();

Config.configure({ populateAppCallResources: true });

let sender: string;
let signer: TransactionSigner;

let FACTORY_ID: bigint;
let factoryClient: FactoryClient;

let tokensInfo: AssetInfo[];
let tokens: bigint[];
let weights: number[];

describe('ChangeWeights', () => {
  beforeEach(fixture.beforeEach);

  beforeAll(async () => {
    await fixture.beforeEach();
    const { algorand } = fixture;

    const manager = await getRandomAccount(fixture, 100_000_000);
    signer = manager.signer;
    sender = manager.sender.toString();

    const stored = await retrieveResult<{ FACTORY_ID: bigint }>('../__test__/test');
    FACTORY_ID = stored.FACTORY_ID;
    factoryClient = algorand.client.getTypedAppClientById(FactoryClient, {
      appId: BigInt(FACTORY_ID),
      defaultSender: sender,
      defaultSigner: signer,
    });
  });

  test('deploy_pool_80/20', async () => {
    const { algorand } = fixture;
    const manager = { algorand, sender, signer };
    await pay(manager, factoryClient.appAddress, 1_000_000);

    // Create some tokens
    const amount = BigInt(10_000_000);
    tokensInfo = [
      await createAndMintToken(manager, '03_TokenA', 'A', amount),
      await createAndMintToken(manager, '03_TokenB', 'B', amount),
    ];
    tokens = tokensInfo.map((el) => el.assetID);
    weights = [0.8, 0.2];

    // Create the pool
    await deployAndInitPool(factoryClient, manager, tokens, weights);
  });

  test('pool_80/20_change_weights', async () => {
    const { algorand } = fixture;
    const manager = { algorand, sender, signer };
    const poolID = (await getPool(factoryClient, tokens, weights))!;

    console.log(`Weight before change => ${await getCurrentWeight(manager, poolID)}`);

    const interpolationTime = 15; // seconds

    await changeWeights(factoryClient, manager, poolID, [0.5, 0.5], interpolationTime);

    const interpolationTimeLeft = await getInterpolationTimeLeft(manager, poolID);
    console.log(`Left => ${interpolationTimeLeft}s`);

    // Weight change happened 0 or some seconds ago
    expect(interpolationTimeLeft).toBeGreaterThan(interpolationTime - 5);
  });

  test('pool_80/20_get_weights_5s', async () => {
    const { algorand } = fixture;
    const manager = { algorand, sender, signer };
    const poolID = (await getPool(factoryClient, tokens, weights))!;

    await sleep(5000);
    const interpolationTimeLeft = await getInterpolationTimeLeft(manager, poolID);

    console.log(`Left => ${interpolationTimeLeft}s`);
    console.log(`Weight after change (+5s) => ${await getCurrentWeight(manager, poolID)}`);

    expect(interpolationTimeLeft).toBeGreaterThan(0);
  });

  test('pool_80/20_get_weights_+15s', async () => {
    const { algorand } = fixture;
    const manager = { algorand, sender, signer };
    const poolID = (await getPool(factoryClient, tokens, weights))!;

    await sleep(10_000);
    console.log(`Left (+15s) => ${await getInterpolationTimeLeft(manager, poolID)}s`);
    console.log(`Weight after change (+15s) => ${await getCurrentWeight(manager, poolID)}`);
  });

  test('pool_80/20_get_weights_+25s', async () => {
    const { algorand } = fixture;
    const manager = { algorand, sender, signer };
    const poolID = (await getPool(factoryClient, tokens, weights))!;

    await sleep(10_000);
    const interpolationTimeLeft = await getInterpolationTimeLeft(manager, poolID);

    console.log(`Left => ${interpolationTimeLeft}s`);
    console.log(`Weight after change (+25s) => ${await getCurrentWeight(manager, poolID)}`);
    expect(interpolationTimeLeft).toBe(0);
  });

  test('deploy_pool_80/20', async () => {
    const { algorand } = fixture;
    const manager = { algorand, sender, signer };
    await pay(manager, factoryClient.appAddress, 1_000_000);

    // Create some tokens
    const amount = BigInt(10_000_000);
    tokensInfo = [
      await createAndMintToken(manager, '03_TokenC', 'C', amount),
      await createAndMintToken(manager, '03_TokenD', 'D', amount),
    ];
    tokens = tokensInfo.map((el) => el.assetID);
    weights = [0.8, 0.2];

    // Create the pool
    await deployAndInitPool(factoryClient, manager, tokens, weights);
  });

  test('pool_80/20_instant_change_weights', async () => {
    const { algorand } = fixture;
    const manager = { algorand, sender, signer };
    const poolID = (await getPool(factoryClient, tokens, weights))!;

    console.log(`Weight before change => ${await getCurrentWeight(manager, poolID)}`);

    await changeWeights(factoryClient, manager, poolID, [0.5, 0.5], 0);
    await sleep(1000);

    const weightsChanged = await getCurrentWeight(manager, poolID);

    console.log(`Weight after change => ${weightsChanged}`);
  });
});
