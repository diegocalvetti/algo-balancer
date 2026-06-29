/* eslint-disable import/no-unresolved, no-console, import/no-cycle */
import { OnSchemaBreak, OnUpdate } from '@algorandfoundation/algokit-utils/types/app';

import { TransactionResponse } from 'algosdk/dist/types/client/v2/indexer';
import { FactoryClient, FactoryFactory } from '../contracts/clients/FactoryClient';
import { AlgoParams, getPayTx, getTxInfo } from './generic';
import { AssetVaultFactory } from '../contracts/clients/AssetVaultClient';
import { PoolTypes } from './pool';
import { DexPoolFactory } from '../contracts/clients/DexPoolClient';

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

  return appDeployer.appId;
}

/*
export async function updatePoolProgram(adminFactory: FactoryClient, program: Uint8Array) {
  const resultTxn = await adminFactory.send.managerUpdatePoolContractProgram({
    args: { programSize: program.length },
    populateAppCallResources: true,
  });

  console.log(`Creating the box for containing the pool program, size: ${program.length}`);
  console.log('TXs IDs: ', resultTxn.txIds);
}
*/

export async function writePoolProgram(factoryClient: FactoryClient, type: PoolTypes, program: Uint8Array) {
  const writeGroup = factoryClient.newGroup();

  for (let i = 0; i < program.length; i += 2000) {
    writeGroup.managerWritePoolContractProgram({
      args: {
        offset: i,
        type,
        data: program.subarray(i, i + 2000),
      },
    });
  }

  await writeGroup.send({ populateAppCallResources: true });
}

export async function factorySetup(manager: AlgoParams, poolType: PoolTypes, APP_ID: bigint) {
  const { algorand } = manager;

  const factoryClient = algorand.client.getTypedAppClientById(FactoryClient, {
    appId: APP_ID,
    defaultSender: manager.sender,
    defaultSigner: manager.signer,
  });

  let poolFactory: DexPoolFactory | AssetVaultFactory | null;

  if (poolType === PoolTypes.Vault) {
    poolFactory = algorand.client.getTypedAppFactory(AssetVaultFactory, {
      defaultSender: manager.sender,
      defaultSigner: manager.signer,
    });
  } else {
    poolFactory = algorand.client.getTypedAppFactory(DexPoolFactory, {
      defaultSender: manager.sender,
      defaultSigner: manager.signer,
    });
  }

  const poolApprovalProgram = await poolFactory.appFactory.compile();

  await algorand.send.payment({
    sender: manager.sender,
    signer: manager.signer,
    receiver: factoryClient.appAddress,
    amount: (10_000_000).microAlgo(),
  });

  // await updatePoolProgram(factoryClient, balancedPoolApprovalProgram.compiledApproval?.compiledBase64ToBytes!);
  await writePoolProgram(factoryClient, poolType, poolApprovalProgram.compiledApproval?.compiledBase64ToBytes!);

  const payment = getPayTx(manager, factoryClient.appAddress, 0.1);

  const poolGroup = factoryClient.newGroup();
  poolGroup.createPool({
    args: [payment, poolType],
  });
  const result = await poolGroup.send({ populateAppCallResources: true, maxRoundsToWaitForConfirmation: 4 });

  const lookup = await getTxInfo(result.txIds[1]);

  const inner = (lookup as TransactionResponse).transaction.innerTxns![0];
  const poolAppId = inner.createdApplicationIndex;

  return { poolAppId };
}
