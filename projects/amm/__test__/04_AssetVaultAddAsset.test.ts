/* eslint-disable no-console, no-await-in-loop */
import { describe, test, beforeAll, beforeEach, expect } from '@jest/globals';
import { Config } from '@algorandfoundation/algokit-utils';
import { algorandFixture } from '@algorandfoundation/algokit-utils/testing';

import { TransactionSigner } from 'algosdk';
import { FactoryClient } from '../contracts/clients/FactoryClient';
import { createAndMintToken } from '../helpers/token';
import { addAsset, deployAndInitPool, getPool } from '../helpers/pool';
import { AssetInfo, getRandomAccount, pay, retrieveResult } from '../helpers/generic';

const fixture = algorandFixture();

Config.configure({ populateAppCallResources: true });

let sender: string;
let signer: TransactionSigner;

let FACTORY_ID: bigint;
let factoryClient: FactoryClient;

let tokensInfo: AssetInfo[];
let tokens: bigint[];
let weights: number[];

describe('AddAsset', () => {
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
      await createAndMintToken(manager, '04_TokenA', 'A', amount),
      await createAndMintToken(manager, '04_TokenB', 'B', amount),
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

    const newToken = await createAndMintToken(manager, '04_TokenC', 'C', BigInt(10_000_000));

    console.log(newToken.assetID);
    await addAsset(factoryClient, manager, poolID, newToken.assetID, 10_000_000);
  });
});
