/* eslint-disable no-console */
import { describe, test, beforeAll, beforeEach, expect } from '@jest/globals';
import { Config } from '@algorandfoundation/algokit-utils';
import { algorandFixture } from '@algorandfoundation/algokit-utils/testing';

import { TransactionSigner } from 'algosdk';
import { FactoryClient } from '../contracts/clients/FactoryClient';
import { createAndMintToken } from '../helpers/token';
import {
  swap,
  addLiquidity,
  createAccountAndMintTokens,
  deployAndInitPool,
  getLiquidity,
  getPool,
} from '../helpers/pool';
import { AssetInfo, getPoolClient, getRandomAccount, pay, retrieveResult } from '../helpers/generic';

const fixture = algorandFixture();

Config.configure({ populateAppCallResources: true });

let sender: string;
let signer: TransactionSigner;

let FACTORY_ID: bigint;
let factoryClient: FactoryClient;

let tokensInfo: AssetInfo[];
let tokens: bigint[];
let weights: number[];

async function mintLPs() {
  const { algorand } = fixture;
  const manager = { algorand, sender, signer };

  const poolID = (await getPool(factoryClient, tokens, weights))!;

  await addLiquidity(factoryClient, manager, poolID, 1, tokens);
  const LP1 = await getLiquidity(factoryClient, manager, poolID);

  const randomLP2 = await createAccountAndMintTokens(fixture, poolID, tokensInfo);
  await addLiquidity(factoryClient, randomLP2, poolID, 1, tokens);
  const LP2 = await getLiquidity(factoryClient, randomLP2, poolID);

  const randomLP3 = await createAccountAndMintTokens(fixture, poolID, tokensInfo);
  await addLiquidity(factoryClient, randomLP3, poolID, 2, tokens);
  const LP3 = await getLiquidity(factoryClient, randomLP3, poolID);

  const randomLP4 = await createAccountAndMintTokens(fixture, poolID, tokensInfo);
  await addLiquidity(factoryClient, randomLP4, poolID, 1 / 3, tokens);
  const LP4 = await getLiquidity(factoryClient, randomLP4, poolID);

  expect(LP2).toEqual(LP1); // 1st & 2nd deposit the same, they should receive the exact same LP tokens amount
  expect(LP3).toEqual(2 * LP2); // 3rd deposit is double the first; it should receive double the LP tokens.
  expect(Math.abs(LP4 - (1 / 3) * LP1)).toBeLessThan(2); // 4th deposit a third, it should receive about one third of the first
}

async function swapTest() {
  const { algorand } = fixture;
  const manager = { algorand, sender, signer };
  const poolID = (await getPool(factoryClient, tokens, weights))!;
  const poolClient = await getPoolClient(manager, poolID);

  const randomUser = await createAccountAndMintTokens(fixture, poolID, tokensInfo, 9_000_000_000);

  const tokenInAmount = 0.01;
  const received = await swap(factoryClient, randomUser, poolID, tokens, 0, 1, tokenInAmount);
  const receivedXsSwap = await swap(factoryClient, randomUser, poolID, tokens, 0, 1, tokenInAmount / 10000);

  const beforeSwapBalanceA = Number(await poolClient.getBalance({ args: [0] })) / 10 ** 6;
  const beforeSwapBalanceB = Number(await poolClient.getBalance({ args: [1] })) / 10 ** 6;
  const receivedXlSwap = await swap(factoryClient, randomUser, poolID, tokens, 0, 1, 100_000_000);
  const afterSwapBalanceA = Number(await poolClient.getBalance({ args: [0] })) / 10 ** 6;

  console.log(beforeSwapBalanceB, afterSwapBalanceA);
  console.log(received, receivedXsSwap, receivedXlSwap);

  expect(received).toBeGreaterThan(0); // random user swaps a 0.01 token A, should receive some tokens B
  expect(received).toBeLessThan(tokenInAmount); // amount of token B should also be less than the provided amount of A
  expect(receivedXsSwap).toBe(0); // if the provided amount is negligible compared to the balance, expect 0 output.
  expect(receivedXlSwap).toBe(beforeSwapBalanceB); // a really large input should drain token B entirely.
  expect(afterSwapBalanceA).toBe(beforeSwapBalanceA + 100_000_000); // Token A balance should equal the previous amount plus the newly added amount.
}

async function getPoolTest() {
  const result = await factoryClient.getPool({
    args: [tokens, weights.map((el) => Number((el * 10 ** 6).toFixed(0)))],
  });

  console.log('Pool Found! ID => ', result);
  expect(result).toBeTruthy();
}

describe('Pool', () => {
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

  test('deploy_pool_50/50', async () => {
    const { algorand } = fixture;
    const manager = { algorand, sender, signer };
    await pay(manager, factoryClient.appAddress, 1_000_000);

    // Create some tokens
    const amount = BigInt(10_000_000);
    tokensInfo = [
      await createAndMintToken(manager, 'tokenA', 'A', amount),
      await createAndMintToken(manager, 'tokenB', 'B', amount),
    ];
    tokens = tokensInfo.map((el) => el.assetID);
    weights = [0.5, 0.5];

    // Create the pool
    await deployAndInitPool(factoryClient, manager, tokens, weights);
  });

  test('get_pool_50/50', getPoolTest);

  test('pool_50/50_mint_lps', mintLPs);

  test('pool_50/50_swaps', swapTest);

  test('deploy_pool_33/33/33', async () => {
    const { algorand } = fixture;
    const manager = { algorand, sender, signer };
    await pay(manager, factoryClient.appAddress, 1_000_000);

    // Create some tokens
    const amount = BigInt(10_000_000);
    tokensInfo = [
      await createAndMintToken(manager, 'tokenC', 'C', amount),
      await createAndMintToken(manager, 'tokenD', 'D', amount),
      await createAndMintToken(manager, 'tokenE', 'E', amount),
    ];
    tokens = tokensInfo.map((el) => el.assetID);
    weights = [1 / 3, 1 / 3, 1 / 3];

    // Create the pool
    await deployAndInitPool(factoryClient, manager, tokens, weights);
  });

  test('get_pool_33/33/33', getPoolTest);

  test('pool_33/33/33_mint_lps', mintLPs);

  test('pool_33/33/33_swaps', swapTest);

  test('deploy_pool_10_tokens', async () => {
    const { algorand } = fixture;
    const manager = { algorand, sender, signer };
    await pay(manager, factoryClient.appAddress, 1_000_000);

    const N = 10;
    // Create some tokens
    const amount = BigInt(10_000_000);
    tokensInfo = await Promise.all(
      Array.from({ length: N }, (_, i) => createAndMintToken(manager, `token${i + 1}`, `${i + 1}`, amount))
    );
    tokens = tokensInfo.map((el) => el.assetID);
    weights = Array.from({ length: N }, () => 1 / N);

    // Create the pool
    await deployAndInitPool(factoryClient, manager, tokens, weights);
  });

  test('get_pool_10_tokens', getPoolTest);

  test('pool_10_tokens_mint_lps', mintLPs);

  test('pool_10_tokens_swaps', swapTest);
});
