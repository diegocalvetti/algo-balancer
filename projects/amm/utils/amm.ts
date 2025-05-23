/* eslint-disable no-console, import/no-extraneous-dependencies, no-await-in-loop, import/no-unresolved, import/no-cycle, no-return-assign */
import * as algokit from '@algorandfoundation/algokit-utils';
import dotenv from 'dotenv';

import algosdk from 'algosdk';
import { BootstrapResult, retrieveResult } from '../script/execute';
import { FactoryClient } from '../contracts/clients/FactoryClient';
import { BalancedPoolV2Client } from '../contracts/clients/BalancedPoolV2Client';
import { account, getTxInfo } from './bootstrap';

dotenv.config();

const algorand = algokit.AlgorandClient.defaultLocalNet();
const decoder = new TextDecoder();

function decodeAssetIDs(bytes: Uint8Array, skipBytes = 2) {
  const view = new DataView(bytes.buffer, bytes.byteOffset + skipBytes, bytes.byteLength - skipBytes);
  const result = [];

  const chunkSize = 8; // uint64
  const totalChunks = Math.floor((bytes.length - skipBytes) / chunkSize);

  for (let i = 0; i < totalChunks * chunkSize; i += chunkSize) {
    const value = view.getBigUint64(i, false); // false → big-endian
    result.push(value);
  }

  return result;
}

export const getPoolAssets = async (POOL_ID: bigint): Promise<bigint[] | null> => {
  const appInfo = await algorand.client.algod.getApplicationByID(POOL_ID).do();
  const globalState = appInfo.params.globalState!;

  let result = null;

  globalState.forEach((entry) => {
    const key = decoder.decode(entry.key);
    const { value } = entry;

    if (key === 'assets') {
      result = decodeAssetIDs(value.bytes);
    }
  });

  return result;
};

export const addLiquidity = async (token: bigint, amount: number) => {
  const { POOL_ID, FACTORY_ID } = await retrieveResult<BootstrapResult>('bootstrap');

  const factoryClient = algorand.client.getTypedAppClientById(FactoryClient, {
    appId: FACTORY_ID,
    defaultSender: account.addr,
    defaultSigner: account.signer,
  });

  const poolClient = algorand.client.getTypedAppClientById(BalancedPoolV2Client, {
    appId: POOL_ID,
    defaultSender: account.addr,
    defaultSigner: account.signer,
  });

  const suggestedParams = await algorand.getSuggestedParams();

  const addLiquidityGroup = factoryClient.newGroup();

  const assetTransferTxn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
    sender: account.addr,
    suggestedParams,
    receiver: poolClient.appAddress,
    amount: BigInt(amount * 10 ** 6),
    assetIndex: token,
  });

  /* const opt = poolClient.newGroup();
  opt.optIn({ args: [token], maxFee: (1_000_000).microAlgo() });
  await opt.send({ populateAppCallResources: true, coverAppCallInnerTransactionFees: true });
   */

  const assets = (await getPoolAssets(POOL_ID))!;
  const index = assets.indexOf(token);

  addLiquidityGroup.addLiquidity({
    args: [POOL_ID, index, assetTransferTxn],
    maxFee: (1_000_000).microAlgo(),
  });

  await addLiquidityGroup.send({
    suppressLog: false,
    populateAppCallResources: true,
    coverAppCallInnerTransactionFees: true,
  });
};

export const computeLiquidity = async () => {
  const { POOL_ID, FACTORY_ID } = await retrieveResult<BootstrapResult>('bootstrap');

  const factoryClient = algorand.client.getTypedAppClientById(FactoryClient, {
    appId: FACTORY_ID,
    defaultSender: account.addr,
    defaultSigner: account.signer,
  });

  const computeLiquidityGroup = factoryClient.newGroup();
  computeLiquidityGroup.getLiquidity({
    args: [POOL_ID],
    maxFee: (100_000).microAlgo(),
  });

  await computeLiquidityGroup.send({
    populateAppCallResources: true,
    coverAppCallInnerTransactionFees: true,
    suppressLog: true,
  });
};

export const burnLiquidity = async (amount: number) => {
  const { POOL_ID, FACTORY_ID, LP_TOKEN_ID } = await retrieveResult<BootstrapResult>('bootstrap');

  const factoryClient = algorand.client.getTypedAppClientById(FactoryClient, {
    appId: FACTORY_ID,
    defaultSender: account.addr,
    defaultSigner: account.signer,
  });

  const poolClient = algorand.client.getTypedAppClientById(BalancedPoolV2Client, {
    appId: POOL_ID,
    defaultSender: account.addr,
    defaultSigner: account.signer,
  });

  const suggestedParams = await algorand.getSuggestedParams();

  const assetTransferTxn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
    sender: account.addr,
    suggestedParams,
    receiver: poolClient.appAddress,
    amount: BigInt(amount * 10 ** 6),
    assetIndex: LP_TOKEN_ID,
  });

  const computeLiquidityGroup = factoryClient.newGroup();
  computeLiquidityGroup.opUp({
    args: [],
    maxFee: (100_000).microAlgo(),
  });
  computeLiquidityGroup.burnLiquidity({
    args: [POOL_ID, assetTransferTxn],
    maxFee: (100_000).microAlgo(),
  });

  await computeLiquidityGroup.send({
    populateAppCallResources: true,
    coverAppCallInnerTransactionFees: true,
    suppressLog: true,
  });
};

export const swap = async (FACTORY_ID: bigint, POOL_ID: bigint, from: bigint, to: bigint, amount: number) => {
  const factoryClient = algorand.client.getTypedAppClientById(FactoryClient, {
    appId: FACTORY_ID,
    defaultSender: account.addr,
    defaultSigner: account.signer,
  });

  const poolClient = algorand.client.getTypedAppClientById(BalancedPoolV2Client, {
    appId: POOL_ID,
    defaultSender: account.addr,
    defaultSigner: account.signer,
  });

  const suggestedParams = await algorand.getSuggestedParams();

  const assetTransferTxn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
    sender: account.addr,
    suggestedParams,
    receiver: poolClient.appAddress,
    amount: BigInt(amount * 10 ** 6),
    assetIndex: from,
  });

  const addLiquidityGroup = factoryClient.newGroup();

  const assets = (await getPoolAssets(POOL_ID))!;
  const indexFrom = assets.indexOf(from);
  const indexTo = assets.indexOf(to);

  addLiquidityGroup.swap({
    args: [POOL_ID, indexFrom, indexTo, assetTransferTxn],
    maxFee: (1_000_000).microAlgo(),
  });

  const res = await addLiquidityGroup.send({ populateAppCallResources: true, coverAppCallInnerTransactionFees: true });
  const tx = await getTxInfo(res.txIds[1]);

  function decodeUint64(buf: Uint8Array): bigint {
    let result = BigInt(0);
    // eslint-disable-next-line no-restricted-syntax
    for (const byte of buf) {
      // eslint-disable-next-line no-bitwise
      result = (result << BigInt(8)) + BigInt(byte);
    }
    return result;
  }

  console.log(tx.transaction.innerTxns![0].logs!.map((el: Uint8Array) => decodeUint64(el)));
};
