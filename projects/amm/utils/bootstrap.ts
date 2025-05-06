/* eslint-disable no-console, import/no-extraneous-dependencies, no-await-in-loop, import/no-unresolved, no-return-assign */
import * as algokit from '@algorandfoundation/algokit-utils';
import { OnSchemaBreak, OnUpdate } from '@algorandfoundation/algokit-utils/types/app';
import dotenv from 'dotenv';

import algosdk from 'algosdk';
import LookupTransactionByID from 'algosdk/dist/types/client/v2/indexer/lookupTransactionByID';
import { TransactionResponse } from 'algosdk/dist/types/client/v2/indexer';
import { AlgoAmount } from '@algorandfoundation/algokit-utils/types/amount';
import { FactoryClient, FactoryFactory } from '../contracts/clients/FactoryClient';
import { TokenClient, TokenFactory } from '../contracts/clients/TokenClient';
import { BalancedPoolV2Client, BalancedPoolV2Factory } from '../contracts/clients/BalancedPoolV2Client';

dotenv.config();

const algorand = algokit.AlgorandClient.defaultLocalNet();
const indexer = new algosdk.Indexer('', 'http://localhost', 8980);

export const account = algorand.account.fromMnemonic(process.env.ACCOUNT_MNEMONIC!);

async function optIn(assetID: bigint) {
  await algorand.send.assetTransfer({
    sender: account.addr,
    signer: account.signer,
    receiver: account.addr,
    assetId: assetID,
    amount: BigInt(0),
  });
}

export async function updatePoolProgram(adminFactory: FactoryClient, program: Uint8Array) {
  const resultTxn = await adminFactory.send.managerUpdatePoolContractProgram({
    args: { programSize: program.length },
    populateAppCallResources: true,
  });

  console.log(`Creating the box for containing the pool program, size: ${program.length}`);
  console.log('TXs IDs: ', resultTxn.txIds);
}

export async function writePoolProgram(factoryClient: FactoryClient, program: Uint8Array) {
  const writeGroup = factoryClient.newGroup();

  for (let i = 0; i < program.length; i += 2000) {
    writeGroup.managerWritePoolContractProgram({
      args: {
        offset: i,
        data: program.subarray(i, i + 2000),
      },
    });
  }

  const resultTxn = await writeGroup.send({ populateAppCallResources: true });
  console.log(`Pool program written, size: ${program.length}`);
  console.log('TXs IDs: ', resultTxn.txIds);
}

// eslint-disable-next-line consistent-return
async function withRetry(fn: CallableFunction, max = 10, delay = 3000): Promise<LookupTransactionByID | undefined> {
  for (let i = 0; i < max; i += 1) {
    try {
      return await fn();
    } catch (err) {
      if (i === max - 1) throw err;

      console.log('Tx not found retrying in 3 second...');
      await new Promise((r) => {
        setTimeout(r, delay);
      });
    }
  }
}

export async function poolSetup(FACTORY_APP_ID: bigint, POOL_ID: bigint, assetIds: bigint[], weights: bigint[]) {
  const factoryClient = algorand.client.getTypedAppClientById(FactoryClient, {
    appId: FACTORY_APP_ID,
    defaultSender: account.addr,
    defaultSigner: account.signer,
  });

  const poolClient = algorand.client.getTypedAppClientById(BalancedPoolV2Client, {
    appId: POOL_ID,
    defaultSender: account.addr,
    defaultSigner: account.signer,
  });

  await algorand.send.payment({
    sender: account.addr,
    signer: account,
    receiver: poolClient.appAddress,
    amount: (1_000_000).microAlgo(),
  });

  console.log('Init Pool with params:', assetIds, weights);

  const group = factoryClient.newGroup();
  group.initPool({
    args: {
      poolId: POOL_ID,
      assetIds,
      weights,
    },
    maxFee: AlgoAmount.MicroAlgo(1_000_000),
  });
  const result = await group.send({ populateAppCallResources: true, coverAppCallInnerTransactionFees: true });
  console.log('TXs Ids:', result.txIds);
  console.log('LP Token ID', result.returns);

  await optIn(result.returns[0]);
}

export async function factorySetup(APP_ID: bigint) {
  const factoryClient = algorand.client.getTypedAppClientById(FactoryClient, {
    appId: APP_ID,
    defaultSender: account.addr,
    defaultSigner: account.signer,
  });

  const balancedPoolFactory = algorand.client.getTypedAppFactory(BalancedPoolV2Factory, {
    defaultSender: account.addr,
    defaultSigner: account.signer,
  });

  const balancedPoolApprovalProgram = await balancedPoolFactory.appFactory.compile();

  await algorand.send.payment({
    sender: account.addr,
    signer: account,
    receiver: factoryClient.appAddress,
    amount: (10_000_000).microAlgo(),
  });

  await updatePoolProgram(factoryClient, balancedPoolApprovalProgram.compiledApproval?.compiledBase64ToBytes!);
  await writePoolProgram(factoryClient, balancedPoolApprovalProgram.compiledApproval?.compiledBase64ToBytes!);

  const poolGroup = factoryClient.newGroup();
  poolGroup.createPool();
  const result = await poolGroup.send({ populateAppCallResources: true, maxRoundsToWaitForConfirmation: 4 });

  console.log('Balanced Pool Created');
  console.log('TXs IDs', result.txIds);

  let lookup: TransactionResponse | null = null;
  await withRetry(async () => (lookup = await indexer.lookupTransactionByID(result.txIds[0]).do()));

  if (!lookup) {
    console.log('sorry i cant :(');
    throw Error();
  }

  const inner = (lookup as TransactionResponse).transaction.innerTxns![0];
  const poolAppId = inner.createdApplicationIndex;

  return { poolAppId };
}

export async function deploy(name: string): Promise<bigint> {
  const factoryFactory = algorand.client.getTypedAppFactory(FactoryFactory, {
    defaultSender: account.addr,
    defaultSigner: account.signer,
  });

  const factoryApprovalProgram = await factoryFactory.appFactory.compile();

  const appDeployer = await algorand.appDeployer.deploy({
    metadata: {
      name,
      version: '0.0.0',
      deletable: false,
      updatable: true,
    },
    createParams: {
      sender: account.addr,
      approvalProgram: factoryApprovalProgram.compiledApproval?.compiledBase64ToBytes!,
      clearStateProgram: factoryApprovalProgram.compiledClear?.compiledBase64ToBytes!,
      schema: {
        globalInts: 2,
        globalByteSlices: 1,
        localInts: 0,
        localByteSlices: 0,
      },
      extraProgramPages: 3,
    },
    updateParams: { sender: account.addr },
    deleteParams: { sender: account.addr },
    onSchemaBreak: OnSchemaBreak.AppendApp,
    onUpdate: OnUpdate.UpdateApp,
    populateAppCallResources: true,
  });

  console.log('\n\n✅ Factory APP_ID IS: ', appDeployer.appId);
  console.log('✅ Factory APP_ADDRESS IS: ', algosdk.encodeAddress(appDeployer.appAddress.publicKey));

  return appDeployer.appId;
}

export async function mintToken(APP_ID: bigint, amount: bigint) {
  const tokenClient = algorand.client.getTypedAppClientById(TokenClient, {
    appId: APP_ID,
    defaultSender: account.addr,
    defaultSigner: account.signer,
  });

  const group = tokenClient.newGroup();
  group.mint({
    args: [amount],
    maxFee: (100_000).microAlgo(),
  });

  await group.send({ populateAppCallResources: true, coverAppCallInnerTransactionFees: true });
}

export async function tokenSetup(APP_ID: bigint, name: string, unit: string): Promise<bigint> {
  const tokenClient = algorand.client.getTypedAppClientById(TokenClient, {
    appId: APP_ID,
    defaultSender: account.addr,
    defaultSigner: account.signer,
  });

  const tx = await algorand.send.payment({
    sender: account.addr,
    signer: account,
    receiver: tokenClient.appAddress,
    amount: (1_000_000).microAlgo(),
    extraFee: (1_000).microAlgo(),
  });

  const encoder = new TextEncoder();
  const result = await tokenClient.send.bootstrap({
    args: { name: encoder.encode(name), unit: encoder.encode(unit), seed: tx.transaction },
    populateAppCallResources: true,
    extraFee: (1_000).microAlgo(),
  });

  const tokenID = result.return!;
  console.log('✅ Asset created, ASSET_ID IS: ', tokenID);
  await optIn(tokenID);

  await mintToken(APP_ID, BigInt(1_000_000));

  return tokenID;
}

export async function deployToken(name: string): Promise<bigint> {
  const tokenFactory = algorand.client.getTypedAppFactory(TokenFactory, {
    defaultSender: account.addr,
    defaultSigner: account.signer,
  });

  const tokenApprovalProgram = await tokenFactory.appFactory.compile();

  const appDeployer = await algorand.appDeployer.deploy({
    metadata: {
      name,
      version: '1.0.1',
      deletable: false,
      updatable: true,
    },
    createParams: {
      sender: account.addr,
      approvalProgram: tokenApprovalProgram.compiledApproval?.compiledBase64ToBytes!,
      clearStateProgram: tokenApprovalProgram.compiledClear?.compiledBase64ToBytes!,
      schema: {
        globalInts: 2,
        globalByteSlices: 1,
        localInts: 0,
        localByteSlices: 0,
      },
      extraProgramPages: 0,
    },
    updateParams: { sender: account.addr },
    deleteParams: { sender: account.addr },
    onSchemaBreak: OnSchemaBreak.AppendApp,
    onUpdate: OnUpdate.UpdateApp,
    populateAppCallResources: true,
  });

  console.log('\n\n✅ Token APP_ID IS: ', appDeployer.appId);
  console.log('✅ Token APP_ADDRESS IS: ', algosdk.encodeAddress(appDeployer.appAddress.publicKey));

  return appDeployer.appId;
}
