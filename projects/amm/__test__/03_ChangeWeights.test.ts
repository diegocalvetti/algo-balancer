/* eslint-disable no-console, no-await-in-loop */
import { describe, test, beforeAll, beforeEach, expect } from '@jest/globals';
import { Config } from '@algorandfoundation/algokit-utils';
import { algorandFixture } from '@algorandfoundation/algokit-utils/testing';

import { TransactionSigner } from 'algosdk';
import { FactoryClient } from '../contracts/clients/FactoryClient';
import { createAndMintToken } from '../helpers/token';
import {
  changeWeights,
  deployAndInitPool,
  fixedWeights,
  getCurrentWeight,
  getInterpolationBlocksLeft,
  getPool,
} from '../helpers/pool';
import { AssetInfo, commonAppCallTxParams, getRandomAccount, pay, retrieveResult, sleep } from '../helpers/generic';

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

    const interpolationTime = 5; // blocks

    await changeWeights(factoryClient, manager, poolID, [0.5, 0.5], interpolationTime);

    for (let i = 1; i <= interpolationTime; i += 1) {
      const interpolationTimeLeft = await getInterpolationBlocksLeft(manager, poolID);
      console.log(`Left => ${interpolationTimeLeft} blocks => ${await getCurrentWeight(manager, poolID)}`);

      await factoryClient.send.opUp({ ...commonAppCallTxParams(manager), args: [], suppressLog: true });

      expect(interpolationTimeLeft).toBe(interpolationTime - i);
    }

    const finalizedWeights = await getCurrentWeight(manager, poolID);

    expect(finalizedWeights).toStrictEqual(fixedWeights([0.5, 0.5]))
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

    const weightsChanged = await getCurrentWeight(manager, poolID);

    console.log(`Weight after change => ${weightsChanged}`);
    expect(weightsChanged).toStrictEqual(fixedWeights([0.5, 0.5]));
  });
});
