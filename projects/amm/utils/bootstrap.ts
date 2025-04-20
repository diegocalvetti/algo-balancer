/* eslint-disable no-console, import/no-extraneous-dependencies */
import * as algokit from '@algorandfoundation/algokit-utils';
import { OnSchemaBreak, OnUpdate } from '@algorandfoundation/algokit-utils/types/app';
import dotenv from 'dotenv';

import { FactoryClient, FactoryFactory } from '../contracts/clients/FactoryClient';
import { TokenClient, TokenFactory } from '../contracts/clients/TokenClient';
import { BalancedPoolV2Factory } from '../contracts/clients/BalancedPoolV2Client';
import {AlgoAmount} from "@algorandfoundation/algokit-utils/types/amount";

dotenv.config();

const algorand = algokit.AlgorandClient.defaultLocalNet();

export const account = algorand.account.fromMnemonic(process.env.ACCOUNT_MNEMONIC!);

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
    amount: (1_000_000).microAlgo(),
  });

  await updatePoolProgram(factoryClient, balancedPoolApprovalProgram.compiledApproval?.compiledBase64ToBytes!);
  await writePoolProgram(factoryClient, balancedPoolApprovalProgram.compiledApproval?.compiledBase64ToBytes!);

  const poolGroup = factoryClient.newGroup();
  poolGroup.createPool();
  const result = await poolGroup.send({ populateAppCallResources: true });

  console.log('Balanced Pool Created');
  console.log('TXs IDs', result.txIds);
}

export async function tokenSetup(APP_ID: bigint) {
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

  const result = await tokenClient.send.bootstrap({
    args: { seed: tx.transaction },
    populateAppCallResources: true,
    extraFee: (1_000).microAlgo(),
  });

  console.log('[Cuba] Token created, ASSET_ID: ', result.return);
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

  console.log('✅ Factory APP_ID IS: ', appDeployer.appId);
  console.log('✅ Factory APP_ADDRESS IS: ', appDeployer.appAddress.publicKey);

  return appDeployer.appId;
}

export async function deployToken(name: string): Promise<bigint> {
  const tokenFactory = algorand.client.getTypedAppFactory(TokenFactory, {
    defaultSender: account.addr,
    defaultSigner: account.signer,
  });

  const factoryApprovalProgram = await tokenFactory.appFactory.compile();

  const appDeployer = await algorand.appDeployer.deploy({
    metadata: {
      name,
      version: '1.0.1',
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
      extraProgramPages: 0,
    },
    updateParams: { sender: account.addr },
    deleteParams: { sender: account.addr },
    onSchemaBreak: OnSchemaBreak.AppendApp,
    onUpdate: OnUpdate.UpdateApp,
    populateAppCallResources: true,
  });

  console.log('✅ Token APP_ID IS: ', appDeployer.appId);
  console.log('✅ Token APP_ADDRESS IS: ', appDeployer.appAddress.publicKey);

  return appDeployer.appId;
}
