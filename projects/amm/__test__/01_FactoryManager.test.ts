/* eslint-disable no-console */
import { describe, test, beforeAll, beforeEach } from '@jest/globals';

import { TransactionSigner } from 'algosdk';
import { algorandFixture } from '@algorandfoundation/algokit-utils/testing';
import { Config } from '@algorandfoundation/algokit-utils';

import { FactoryClient, FactoryFactory } from '../contracts/clients/FactoryClient';
import { AssetVaultFactory } from '../contracts/clients/AssetVaultClient';
import { pay, storeResult } from '../helpers/generic';

const fixture = algorandFixture();
Config.configure({ populateAppCallResources: true });

let appClient: FactoryClient;
let poolFactory: AssetVaultFactory;
let sender: string;
let signer: TransactionSigner;

/**
 * Deploy & Set up the Factory.
 * The factory `appID` is then stored in test.json available to use in the other tests.
 */
describe('FactoryManager', () => {
  beforeEach(fixture.beforeEach);

  beforeAll(async () => {
    await fixture.beforeEach();
    const { algorand } = fixture;

    fixture.context.testAccount = await fixture.context.generateAccount({ initialFunds: (1000).algo() });
    signer = fixture.context.testAccount.signer;
    sender = fixture.context.testAccount.addr.toString();

    poolFactory = new AssetVaultFactory({
      algorand,
      defaultSender: sender,
      defaultSigner: signer,
    });
  });

  test('factory_deploy', async () => {
    const { algorand } = fixture;

    const factory = new FactoryFactory({
      algorand,
      defaultSender: sender,
      defaultSigner: signer,
    });

    const createResult = await factory.send.create.createApplication();
    appClient = createResult.appClient;

    await storeResult('../__test__/test', { FACTORY_ID: appClient.appId });
    console.log(`✅ Factory Deployed => ${appClient.appId}`);
  });

  test('factory_write_pool_program', async () => {
    const assetVaultProgram = await poolFactory.appFactory.compile();
    const program = assetVaultProgram.compiledApproval?.compiled!;

    const { algorand } = fixture;
    const config = {
      algorand,
      sender,
      signer,
    };

    await pay(config, appClient.appAddress, 10);

    await appClient.send.managerUpdatePoolContractProgram({
      args: [program.length],
      maxFee: (100_000).microAlgo(),
      coverAppCallInnerTransactionFees: true,
      populateAppCallResources: true,
      sender,
      signer,
    });

    const programBase64 = assetVaultProgram.compiledApproval?.compiledBase64ToBytes!;

    const writeGroup = appClient.newGroup();

    for (let i = 0; i < programBase64.length; i += 2000) {
      writeGroup.managerWritePoolContractProgram({
        args: {
          offset: i,
          data: programBase64.subarray(i, i + 2000),
        },
        maxFee: (100_000).microAlgo(),
        sender,
        signer,
      });
    }

    const result = await writeGroup.send({ populateAppCallResources: true, coverAppCallInnerTransactionFees: true });
    console.log(`✅ Pool Program Written! => txs: ${result.txIds}`);
  });
});
