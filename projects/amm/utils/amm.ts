/* eslint-disable no-console, import/no-extraneous-dependencies, no-await-in-loop, import/no-unresolved, no-return-assign */
import * as algokit from '@algorandfoundation/algokit-utils';
import dotenv from 'dotenv';

import algosdk from 'algosdk';
import { BootstrapResult, retrieveResult } from '../script/execute';
import { FactoryClient } from '../contracts/clients/FactoryClient';
import { BalancedPoolV2Client } from '../contracts/clients/BalancedPoolV2Client';
import { account } from './bootstrap';

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

  const opt = poolClient.newGroup();
  opt.optIn({ args: [token], maxFee: (1_000_000).microAlgo() });
  await opt.send({ populateAppCallResources: true, coverAppCallInnerTransactionFees: true });

  const assets = (await getPoolAssets(POOL_ID))!;
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore
  const index = assets.indexOf(token);
  console.log(assets, token, index);

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
