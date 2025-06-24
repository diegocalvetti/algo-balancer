/* eslint-disable no-restricted-syntax, no-await-in-loop, guard-for-in, no-console, import/no-cycle */
import { AlgorandFixture } from '@algorandfoundation/algokit-utils/types/testing';
import {
  AlgoParams,
  AssetInfo,
  commonAppCallTxParams,
  getPoolClient,
  getRandomAccount,
  getTxInfo,
  makeAssetTransferTxn,
  optIn,
  pay,
} from './generic';
import { FactoryClient } from '../contracts/clients/FactoryClient';
import { mintToken } from './token';
import moment from "moment";

export async function getPool(
  factoryClient: FactoryClient,
  tokens: bigint[],
  weights: number[]
): Promise<bigint | undefined> {
  const weightsFixed = weights.map((el) => BigInt((el * 10 ** 6).toFixed(0).toString()));
  const result = await factoryClient.getPool({
    args: [tokens, weightsFixed],
  });
  return result?.id;
}

export async function initPool(
  factoryClient: FactoryClient,
  config: AlgoParams,
  poolID: bigint,
  tokens: bigint[],
  weights: number[]
) {
  const poolClient = await getPoolClient(config, poolID);
  await pay(config, factoryClient.appAddress, 10);
  await pay(config, poolClient.appAddress, 10);

  const weightsFixed = weights.map((el) => BigInt((el * 10 ** 6).toFixed(0).toString()));
  const initPoolGroup = factoryClient.newGroup();

  const opUpAmount = tokens.length / 2 + 1;

  for (let i = 0; i < opUpAmount; i += 1) {
    initPoolGroup.opUp({
      ...commonAppCallTxParams(config),
      args: [],
      note: new Uint8Array([i]),
    });
  }

  initPoolGroup.initPool({
    ...commonAppCallTxParams(config, (500_000).microAlgo()),
    args: [poolID, tokens, weightsFixed],
  });

  const resultInit = await initPoolGroup.send({
    populateAppCallResources: true,
    coverAppCallInnerTransactionFees: true,
  });

  const lpID = resultInit.returns[resultInit.returns.length - 1]!;

  await optIn(config, lpID);
  return lpID;
}

export async function deployAndInitPool(
  factoryClient: FactoryClient,
  config: AlgoParams,
  tokens: bigint[],
  weights: number[]
): Promise<bigint> {
  // Create the pool
  const result = await factoryClient.send.createPool({ args: [], populateAppCallResources: true });

  const tx = await getTxInfo(result.txIds[0]);
  const poolID = tx.transaction.innerTxns![0].createdApplicationIndex!;

  return initPool(factoryClient, config, poolID, tokens, weights);
}

export async function addLiquidity(
  factoryClient: FactoryClient,
  config: AlgoParams,
  poolID: bigint,
  amount: number,
  tokens: bigint[]
) {
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    await optIn(config, token);
    console.log('TOKEN => ', token);
    const poolClient = await getPoolClient(config, poolID);

    const assetTransferTxn = await makeAssetTransferTxn(config, token, poolClient.appAddress, amount);

    await factoryClient.send.addLiquidity({
      ...commonAppCallTxParams(config, (500_000).microAlgo()),
      args: [poolID, index, assetTransferTxn],
    });
  }
}

export async function getLiquidity(factoryClient: FactoryClient, config: AlgoParams, poolID: bigint): Promise<number> {
  const group = factoryClient.newGroup();
  const poolClient = await getPoolClient(config, poolID);
  const totalAssets = await poolClient.getTotalAssets();

  for (let i = 0; i < totalAssets; i += 1) {
    group.opUp({
      ...commonAppCallTxParams(config),
      args: [],
      note: new Uint8Array([i]),
    });
  }

  group.getLiquidity({
    ...commonAppCallTxParams(config),
    args: [poolID],
  });

  const result = await group.send({
    ...commonAppCallTxParams(config),
  });

  return Number(result.returns[1]!) / 10 ** 6;
}

export async function createAccountAndMintTokens(
  fixture: AlgorandFixture,
  poolID: bigint,
  tokens: AssetInfo[],
  amount: number = 500_000
) {
  const randomLP = await getRandomAccount(fixture);
  const poolClient = await getPoolClient(randomLP, poolID);
  const tokenLpId = await poolClient.getToken();

  await optIn(randomLP, tokenLpId);

  for (const token of tokens) {
    await optIn(randomLP, token.assetID);
    await mintToken(randomLP, token, BigInt(amount));
  }

  return randomLP;
}

export async function swap(
  factoryClient: FactoryClient,
  config: AlgoParams,
  poolID: bigint,
  tokens: bigint[],
  from: number,
  to: number,
  amount: number
): Promise<number> {
  const poolClient = await getPoolClient(config, poolID);
  const assetTransferTxn = await makeAssetTransferTxn(config, tokens[from], poolClient.appAddress, amount);

  const result = await factoryClient.send.swap({
    ...commonAppCallTxParams(config),
    args: [poolID, from, to, assetTransferTxn],
  });

  return Number(result.return!) / 10 ** 6;
}

export const burnLiquidity = async (
  factoryClient: FactoryClient,
  config: AlgoParams,
  poolID: bigint,
  lpID: bigint,
  amount: number
) => {
  const poolClient = await getPoolClient(config, poolID);
  const assetTransferTxn = makeAssetTransferTxn(config, lpID, poolClient.appAddress, amount);

  const computeLiquidityGroup = factoryClient.newGroup();
  computeLiquidityGroup.opUp({
    args: [],
    maxFee: (100_000).microAlgo(),
  });
  computeLiquidityGroup.burnLiquidity({
    args: [poolID, assetTransferTxn],
    maxFee: (100_000).microAlgo(),
  });

  await computeLiquidityGroup.send({
    populateAppCallResources: true,
    coverAppCallInnerTransactionFees: true,
  });
};

export async function changeWeights(
  factoryClient: FactoryClient,
  config: AlgoParams,
  poolID: bigint,
  weights: number[],
  duration: number
) {
  const weightsFixed = weights.map((el) => BigInt((el * 10 ** 6).toFixed(0).toString()));

  await factoryClient.send.changeWeights({
    ...commonAppCallTxParams(config),
    args: [poolID, weightsFixed, duration],
    suppressLog: true,
  });
}

export async function getCurrentWeight(config: AlgoParams, poolID: bigint): Promise<bigint[]> {
  const poolClient = await getPoolClient(config, poolID);
  const tokensAmount = await poolClient.getTotalAssets({ args: [] });

  const weights = [];
  for (let i = 0; i < tokensAmount; i += 1) {
    weights.push((await poolClient.send.getCurrentWeight({ args: [i] })).return!);
  }

  return weights;
}

export async function getInterpolationTimeLeft(config: AlgoParams, poolID: bigint): Promise<number> {
  const poolClient = await getPoolClient(config, poolID);
  const timesResponse = await poolClient.send.getTimes({ args: [] });

  const times = timesResponse.return!;
  const diff = moment.unix(Number(times[1])).diff(moment.unix(Number(times[2])))

  return diff > 0 ? diff / 1000 : 0;
}
