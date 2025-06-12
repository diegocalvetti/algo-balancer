/* eslint-disable import/no-unresolved, consistent-return, import/no-cycle, no-console */
import { AlgorandClient } from '@algorandfoundation/algokit-utils';
import { AlgoAmount } from '@algorandfoundation/algokit-utils/types/amount';
import { AlgorandFixture } from '@algorandfoundation/algokit-utils/types/testing';
import algosdk, { Address, AtomicTransactionComposer, TransactionSigner } from 'algosdk';

import LookupTransactionByID from 'algosdk/dist/types/client/v2/indexer/lookupTransactionByID';
import { TransactionResponse } from 'algosdk/dist/types/client/v2/indexer';
import fs from 'node:fs';
import path from 'node:path';
import { BalancedPoolV2Client } from '../contracts/clients/BalancedPoolV2Client';
import { FactoryClient } from '../contracts/clients/FactoryClient';
import { BootstrapResult } from '../script/execute';

export type AssetInfo = {
  appID: bigint;
  assetID: bigint;
};

export type AlgoParams = {
  algorand: AlgorandClient;
  sender: string | Readonly<Address>;
  signer: TransactionSigner;
};
const indexer = new algosdk.Indexer('', 'http://localhost', 8980);

export async function optIn(params: AlgoParams, assetID: bigint) {
  const { algorand, sender, signer } = params;

  await algorand.send.assetTransfer({
    sender,
    signer,
    receiver: sender,
    assetId: assetID,
    amount: BigInt(0),
  });
}

export function commonAppCallTxParams(params: AlgoParams, maxFee: AlgoAmount = (100_000).microAlgo()) {
  const { sender, signer } = params;
  return {
    sender,
    signer,
    maxFee,
    coverAppCallInnerTransactionFees: true,
    populateAppCallResources: true,
  };
}

export function makeAssetTransferTxn(params: AlgoParams, assetId: bigint, receiver: string | Address, amount: number) {
  const { algorand, sender, signer } = params;

  return algorand.createTransaction.assetTransfer({
    sender,
    signer,
    receiver,
    assetId,
    amount: amount.algo().microAlgo,
  });
}

export async function pay(params: AlgoParams, receiver: string | Address, amount: number) {
  const { algorand, sender, signer } = params;
  const suggestedParams = await algorand.getSuggestedParams();
  suggestedParams.fee = (500_000).microAlgo().microAlgo;
  suggestedParams.flatFee = true;

  const tx = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
    sender,
    receiver,
    amount: amount.algo().microAlgo,
    suggestedParams,
  });

  const atc = new AtomicTransactionComposer();
  atc.addTransaction({ txn: tx, signer });
  await atc.execute(algorand.client.algod, 4);
}

export async function getFactoryClient(params: AlgoParams, id: number | bigint): Promise<FactoryClient> {
  const { algorand, sender, signer } = params;

  return algorand.client.getTypedAppClientById(FactoryClient, {
    appId: BigInt(id),
    defaultSender: sender,
    defaultSigner: signer,
  });
}

export async function getPoolClient(params: AlgoParams, id: bigint): Promise<BalancedPoolV2Client> {
  const { algorand, sender, signer } = params;

  return algorand.client.getTypedAppClientById(BalancedPoolV2Client, {
    appId: BigInt(id),
    defaultSender: sender,
    defaultSigner: signer,
  });
}

/**
 * Intended to use on localnet for testing only
 * @param fixture Algorand Testing Fixture
 * @param fund Initial fund amount in Algo
 */
export async function getRandomAccount(fixture: AlgorandFixture, fund: number = 10_000): Promise<AlgoParams> {
  // eslint-disable-next-line no-param-reassign
  fixture.context.testAccount = await fixture.context.generateAccount({ initialFunds: fund.algo() });

  return {
    algorand: fixture.algorand,
    sender: fixture.context.testAccount.addr.toString(),
    signer: fixture.context.testAccount.signer,
  };
}

async function withRetry(fn: CallableFunction, max = 10, delay = 3000): Promise<LookupTransactionByID | undefined> {
  for (let i = 0; i < max; i += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop
      return await fn();
    } catch (err) {
      if (i === max - 1) throw err;

      console.log('Tx not found retrying in 3 second...');
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => {
        setTimeout(r, delay);
      });
    }
  }
}

export async function getTxInfo(txId: string): Promise<TransactionResponse> {
  let lookup: TransactionResponse | null = null;
  // eslint-disable-next-line no-return-assign
  await withRetry(async () => (lookup = await indexer.lookupTransactionByID(txId).do()));

  if (!lookup) {
    console.log('sorry i cant :(');
    throw Error();
  }

  return lookup as TransactionResponse;
}

export async function retrieveResult<T = unknown>(filename: string): Promise<T> {
  const filePath = path.resolve(__dirname, `./${filename}.json`);
  const fileContent = fs.readFileSync(filePath, 'utf8');

  const parsed = JSON.parse(fileContent, (_, value) => {
    if (typeof value === 'string' && /^\d+$/.test(value)) {
      return BigInt(value);
    }
    return value;
  });

  return parsed as T;
}

export async function storeResult(filename: string, data: object): Promise<void> {
  const current = await retrieveResult<BootstrapResult>(filename);

  const json = JSON.stringify(
    { ...current, ...data },
    (_, value) => (typeof value === 'bigint' ? value.toString() : value),
    2
  );
  const filePath = path.resolve(__dirname, `./${filename}.json`);

  return new Promise((resolve, reject) => {
    fs.writeFile(filePath, json, 'utf8', (err) => {
      if (err) {
        console.error(`❌ Errore durante la scrittura su ${filename}:`, err);
        reject(err);
      } else {
        console.log(`✅ Result of ${filename} saved: ${filePath}`);
        resolve();
      }
    });
  });
}
