import { describe, test, beforeAll, beforeEach } from '@jest/globals';
import { Config } from '@algorandfoundation/algokit-utils';
import { algorandFixture } from '@algorandfoundation/algokit-utils/testing';

import { TransactionSigner } from 'algosdk';
import { FactoryClient } from '../contracts/clients/FactoryClient';
import { createAndMintToken, mintToken } from '../helpers/token';
import { addLiquidity, deployAndInitPool, getLiquidity, getPool } from '../helpers/pool';
import { AssetInfo, getPoolClient, getRandomAccount, optIn } from '../helpers/generic';

const fixture = algorandFixture();

Config.configure({ populateAppCallResources: true });

let sender: string;
let signer: TransactionSigner;

const FACTORY_ID = 2030;
let factoryClient: FactoryClient;

let tokens: AssetInfo[];
let weights: number[];

describe('Pool', () => {
  beforeEach(fixture.beforeEach);

  beforeAll(async () => {
    await fixture.beforeEach();
    const { algorand } = fixture;

    const manager = await getRandomAccount(fixture, 100_000);
    signer = manager.signer;
    sender = manager.sender;

    factoryClient = algorand.client.getTypedAppClientById(FactoryClient, {
      appId: BigInt(FACTORY_ID),
      defaultSender: sender,
      defaultSigner: signer,
    });
  });

  test('deploy_pool_50/50', async () => {
    const { algorand } = fixture;
    const manager = { algorand, sender, signer };

    // Create some tokens
    const amount = BigInt(10_000_000);
    tokens = [await createAndMintToken(manager, 'tokenA', amount), await createAndMintToken(manager, 'tokenB', amount)];
    weights = [0.5, 0.5];

    // Create the pool
    await deployAndInitPool(factoryClient, manager, tokens, weights);
  });

  test('get_pool_50/50', async () => {
    const result = await factoryClient.getPool({
      args: [tokens.map((el) => el.assetID), weights.map((el) => el * 10 ** 6)],
    });

    console.log('Pool Found! ID => ', result);
  });

  test('pool_50/50_get_lp_proportionally', async () => {
    const { algorand } = fixture;
    const manager = { algorand, sender, signer };

    const poolID = (await getPool(factoryClient, tokens, weights))!;

    await addLiquidity(factoryClient, manager, poolID, tokens[0].assetID, 0, 100_000);
    await addLiquidity(factoryClient, manager, poolID, tokens[1].assetID, 1, 100_000);
    const getLiquidity1Txs = await getLiquidity(factoryClient, manager, poolID);

    const randomLP = await getRandomAccount(fixture);
    const poolClient = await getPoolClient(randomLP, poolID);
    const tokenLpId = await poolClient.getToken();

    await optIn(randomLP, tokenLpId);
    await optIn(randomLP, tokens[0].assetID);
    await optIn(randomLP, tokens[1].assetID);
    await mintToken(randomLP, tokens[0], BigInt(500_000));
    await mintToken(randomLP, tokens[1], BigInt(500_000));

    await addLiquidity(factoryClient, randomLP, poolID, tokens[0].assetID, 0, 100_000);
    await addLiquidity(factoryClient, randomLP, poolID, tokens[1].assetID, 1, 100_000);
    const getLiquidity2Txs = await getLiquidity(factoryClient, randomLP, poolID);

    console.log(getLiquidity1Txs, getLiquidity2Txs);
  });

  test('pool_33/33/33_get_lp_proportionally', async () => {
    const { algorand } = fixture;
    const manager = { algorand, sender, signer };

    const amount = BigInt(10_000_000);
    tokens = [...tokens, await createAndMintToken(manager, 'tokenC', amount)];
    weights = [1 / 3, 1 / 3, 1 / 3];

    await deployAndInitPool(factoryClient, manager, tokens, weights);

    const poolID = (await getPool(factoryClient, tokens, weights))!;

    await addLiquidity(factoryClient, manager, poolID, tokens[0].assetID, 0, 100_000);
    await addLiquidity(factoryClient, manager, poolID, tokens[1].assetID, 1, 100_000);
    await addLiquidity(factoryClient, manager, poolID, tokens[2].assetID, 2, 100_000);
    const getLiquidity1Txs = await getLiquidity(factoryClient, manager, poolID);

    const randomLP = await getRandomAccount(fixture);
    const poolClient = await getPoolClient(randomLP, poolID);
    const tokenLpId = await poolClient.getToken();

    await optIn(randomLP, tokenLpId);
    await optIn(randomLP, tokens[0].assetID);
    await optIn(randomLP, tokens[1].assetID);
    await optIn(randomLP, tokens[2].assetID);
    await mintToken(randomLP, tokens[0], BigInt(500_000));
    await mintToken(randomLP, tokens[1], BigInt(500_000));
    await mintToken(randomLP, tokens[2], BigInt(500_000));

    await addLiquidity(factoryClient, randomLP, poolID, tokens[0].assetID, 0, 100_000);
    await addLiquidity(factoryClient, randomLP, poolID, tokens[1].assetID, 1, 200_000);
    await addLiquidity(factoryClient, randomLP, poolID, tokens[2].assetID, 2, 200_000);
    const getLiquidity2Txs = await getLiquidity(factoryClient, randomLP, poolID);

    console.log(getLiquidity1Txs, getLiquidity2Txs);
  });
});
