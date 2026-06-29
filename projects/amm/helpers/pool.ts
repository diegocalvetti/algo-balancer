/* eslint-disable no-restricted-syntax, no-await-in-loop, guard-for-in, no-console, import/no-cycle */
import { AlgorandFixture } from '@algorandfoundation/algokit-utils/types/testing';
import {
  AlgoParams,
  AssetInfo,
  commonAppCallTxParams,
  getPayTx,
  getPoolClient,
  getRandomAccount,
  getTxInfo,
  makeAssetTransferTxn,
  optIn,
} from './generic';
import { FactoryClient } from '../contracts/clients/FactoryClient';
import { mintToken } from './token';
import { estimateSwapOffChain } from './estimateSwap';
import { AssetVaultClient } from '../contracts/clients/AssetVaultClient';
import { DexPoolClient } from '../contracts/clients/DexPoolClient';
import { DexPool } from '../contracts/DexPool.algo';

export function fixedWeights(weights: number[]): bigint[] {
  return weights.map((el) => BigInt((el * 10 ** 6).toFixed(0).toString()));
}

export const enum PoolTypes {
  Vault = 0,
  Dex = 1,
}

export function getPoolTypeName(type: PoolTypes) {
  return type === PoolTypes.Vault ? 'AssetVault' : 'AssetDex';
}

export async function getPool(
  factoryClient: FactoryClient,
  tokens: bigint[],
  weights: number[]
): Promise<bigint | undefined> {
  const weightsFixed = fixedWeights(weights);
  const result = await factoryClient.getPool({
    args: [tokens, weightsFixed],
  });
  return result?.id;
}

export async function initPool(
  factoryClient: FactoryClient,
  config: AlgoParams,
  poolType: PoolTypes,
  poolID: bigint,
  tokens: bigint[],
  weights: number[]
) {
  const poolClient: AssetVaultClient | DexPoolClient = await getPoolClient(config, poolType, poolID);
  const payTx = await getPayTx(config, poolClient.appAddress, 1);

  const weightsFixed = fixedWeights(weights);
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
    args: [poolID, poolType, tokens, weightsFixed, payTx],
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
  poolType: PoolTypes,
  tokens: bigint[],
  weights: number[]
): Promise<bigint> {
  const payTx = await getPayTx(config, factoryClient.appAddress, 0.1);

  const result = await factoryClient.send.createPool({ args: [payTx, poolType], populateAppCallResources: true });

  const tx = await getTxInfo(result.txIds[1]);
  const poolID = tx.transaction.innerTxns![0].createdApplicationIndex!;

  return initPool(factoryClient, config, poolType, poolID, tokens, weights);
}

export async function addLiquidity(
  config: AlgoParams,
  poolType: PoolTypes,
  poolID: bigint,
  amount: number,
  tokens: bigint[]
) {
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    await optIn(config, token);
    const poolClient = await getPoolClient(config, poolType, poolID);

    const assetTransferTxn = await makeAssetTransferTxn(config, token, poolClient.appAddress, amount);

    await poolClient.send.addLiquidity({
      ...commonAppCallTxParams(config, (500_000).microAlgo()),
      args: [index, assetTransferTxn],
    });
  }
}

export async function getLiquidity(config: AlgoParams, poolType: PoolTypes, poolID: bigint): Promise<number> {
  const poolClient = await getPoolClient(config, poolType, poolID);
  const group = poolClient.newGroup();
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
    args: [],
  });

  const result = await group.send({
    ...commonAppCallTxParams(config),
  });

  return Number(result.returns[2]!) / 10 ** 6;
}

export async function createAccountAndMintTokens(
  fixture: AlgorandFixture,
  poolType: PoolTypes,
  poolID: bigint,
  tokens: AssetInfo[],
  amount: number = 500_000
) {
  const randomLP = await getRandomAccount(fixture);
  const poolClient = await getPoolClient(randomLP, poolType, poolID);
  const tokenLpId = await poolClient.getToken();

  await optIn(randomLP, tokenLpId);

  for (const token of tokens) {
    await optIn(randomLP, token.assetID);
    await mintToken(randomLP, token, BigInt(amount));
  }

  return randomLP;
}

export async function swap(
  config: AlgoParams,
  poolType: PoolTypes,
  poolID: bigint,
  tokens: bigint[],
  from: number,
  to: number,
  amount: number
): Promise<number> {
  const poolClient = await getPoolClient(config, poolType, poolID);
  const assetTransferTxn = await makeAssetTransferTxn(config, tokens[from], poolClient.appAddress, amount);

  const estimate = await estimateSwapOffChain(poolClient as AssetVaultClient, from, to, BigInt(amount * 10 ** 6));

  const slippagePct = 0.5; // 0.5%
  const factor = Math.floor((1 - slippagePct / 100) * 10000); // 9950
  const minOut = (estimate * BigInt(factor)) / BigInt(10000);

  const result = await poolClient.send.swap({
    ...commonAppCallTxParams(config),
    args: [from, to, minOut, assetTransferTxn],
  });

  return Number(result.return!) / 10 ** 6;
}

export const burnLiquidity = async (
  config: AlgoParams,
  poolType: PoolTypes,
  poolID: bigint,
  lpID: bigint,
  amount: number
) => {
  const poolClient = await getPoolClient(config, poolType, poolID);
  const assetTransferTxn = makeAssetTransferTxn(config, lpID, poolClient.appAddress, amount);

  const computeLiquidityGroup = poolClient.newGroup();
  computeLiquidityGroup.opUp({
    args: [],
    maxFee: (100_000).microAlgo(),
  });
  computeLiquidityGroup.burnLiquidity({
    args: [assetTransferTxn],
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
  poolType: PoolTypes,
  poolID: bigint,
  weights: number[],
  duration: number
) {
  const poolClient = await getPoolClient(config, poolType, poolID);
  const weightsFixed = fixedWeights(weights);

  await poolClient.send.changeWeights({
    ...commonAppCallTxParams(config),
    args: [duration, weightsFixed],
    suppressLog: true,
  });
}

export async function getCurrentWeight(config: AlgoParams, poolType: PoolTypes, poolID: bigint): Promise<bigint[]> {
  const poolClient = await getPoolClient(config, poolType, poolID);
  const tokensAmount = await poolClient.getTotalAssets({ args: [] });

  const weights = [];
  for (let i = 0; i < tokensAmount; i += 1) {
    weights.push((await poolClient.send.getCurrentWeight({ args: [i] })).return!);
  }

  return weights;
}

export async function getInterpolationBlocksLeft(
  config: AlgoParams,
  poolType: PoolTypes,
  poolID: bigint
): Promise<number> {
  const poolClient = await getPoolClient(config, poolType, poolID);
  const timesResponse = await poolClient.send.getTimes({ args: [] });

  const times = timesResponse.return!;
  const diff = Number(times[1] - times[2]);

  return diff > 0 ? diff : 0;
}

export async function getAuctionState(config: AlgoParams, poolType: PoolTypes, poolID: bigint): Promise<bigint[]> {
  const poolClient = (await getPoolClient(config, poolType, poolID)) as DexPoolClient;
  const auctionStateResponse = await poolClient.send.getAuctionState({ args: [] });

  return auctionStateResponse.return!;
}
