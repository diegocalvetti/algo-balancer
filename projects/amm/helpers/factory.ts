/* eslint-disable import/no-unresolved, no-console, import/no-cycle */
import { OnSchemaBreak, OnUpdate } from '@algorandfoundation/algokit-utils/types/app';
import algosdk from 'algosdk';

import { TransactionResponse } from 'algosdk/dist/types/client/v2/indexer';
import { FactoryClient, FactoryFactory } from '../contracts/clients/FactoryClient';
import { AlgoParams, getTxInfo } from './generic';
import { BalancedPoolV2Factory } from '../contracts/clients/BalancedPoolV2Client';

export async function deploy(manager: AlgoParams, name: string): Promise<bigint> {
  const { algorand } = manager;
  const factoryFactory = algorand.client.getTypedAppFactory(FactoryFactory, {
    defaultSender: manager.sender,
    defaultSigner: manager.signer,
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
      sender: manager.sender,
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
    updateParams: { sender: manager.sender },
    deleteParams: { sender: manager.sender },
    onSchemaBreak: OnSchemaBreak.AppendApp,
    onUpdate: OnUpdate.UpdateApp,
    populateAppCallResources: true,
  });

  console.log('\n\n✅ Factory APP_ID IS: ', appDeployer.appId);
  console.log('✅ Factory APP_ADDRESS IS: ', algosdk.encodeAddress(appDeployer.appAddress.publicKey));

  return appDeployer.appId;
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

export async function factorySetup(manager: AlgoParams, APP_ID: bigint) {
  const { algorand } = manager;

  const factoryClient = algorand.client.getTypedAppClientById(FactoryClient, {
    appId: APP_ID,
    defaultSender: manager.sender,
    defaultSigner: manager.signer,
  });

  const balancedPoolFactory = algorand.client.getTypedAppFactory(BalancedPoolV2Factory, {
    defaultSender: manager.sender,
    defaultSigner: manager.signer,
  });

  const balancedPoolApprovalProgram = await balancedPoolFactory.appFactory.compile();

  await algorand.send.payment({
    sender: manager.sender,
    signer: manager.signer,
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

  const lookup = await getTxInfo(result.txIds[0]);

  const inner = (lookup as TransactionResponse).transaction.innerTxns![0];
  const poolAppId = inner.createdApplicationIndex;

  return { poolAppId };
}
