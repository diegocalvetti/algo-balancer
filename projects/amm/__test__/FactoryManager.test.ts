import { describe, test, beforeAll, beforeEach, afterAll } from '@jest/globals';
import { algorandFixture } from '@algorandfoundation/algokit-utils/testing';
import { Config } from '@algorandfoundation/algokit-utils';
import algosdk, { AtomicTransactionComposer, TransactionSigner } from 'algosdk';
import { after } from 'node:test';
import { FactoryClient, FactoryFactory } from '../contracts/clients/FactoryClient';
import { BalancedPoolV2Factory } from '../contracts/clients/BalancedPoolV2Client';
import {TransactionResponse} from "algosdk/dist/types/client/v2/indexer";
import {getTxInfo} from "../utils/bootstrap";

const fixture = algorandFixture();
Config.configure({ populateAppCallResources: true });

let appClient: FactoryClient;
let poolFactory: BalancedPoolV2Factory;
let sender: string;
let signer: TransactionSigner;

describe('Factory', () => {
  beforeEach(fixture.beforeEach);

  beforeAll(async () => {
    await fixture.beforeEach();
    const { algorand } = fixture;

    fixture.context.testAccount = await fixture.context.generateAccount({ initialFunds: (100).algo() });
    signer = fixture.context.testAccount.signer;
    sender = fixture.context.testAccount.addr.toString();

    poolFactory = new BalancedPoolV2Factory({
      algorand,
      defaultSender: sender,
      defaultSigner: signer,
    });
  });

  afterAll(async () => {
    console.log({
      FACTORY: appClient.appId,
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

    console.log(`✅ Factory Deployed => ${appClient.appId}`);
    
    /*
   const balancedPoolApprovalProgram = await poolFactory.appFactory.compile();
   const program = balancedPoolApprovalProgram.compiledApproval?.compiled!;

   await appClient.send.managerUpdatePoolContractProgram({
     args: [program.length],
     sender,
     signer,
   });
   const programBase64 = balancedPoolApprovalProgram.compiledApproval?.compiledBase64ToBytes!;

   const writeGroup = appClient.newGroup();

   for (let i = 0; i < programBase64.length; i += 2000) {
     writeGroup.managerWritePoolContractProgram({
       args: {
         offset: i,
         data: programBase64.subarray(i, i + 2000),
       },
     });
   }

   await writeGroup.send({ populateAppCallResources: true, coverAppCallInnerTransactionFees: true });
   */
  });

  test('factory_write_pool_program', async () => {
    const balancedPoolApprovalProgram = await poolFactory.appFactory.compile();
    const program = balancedPoolApprovalProgram.compiledApproval?.compiled!;

    const { algorand } = fixture;

    const tx = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
      sender,
      receiver: appClient.appAddress,
      amount: 10e6,
      suggestedParams: await algorand.getSuggestedParams(),
    });

    const atc = new AtomicTransactionComposer();
    atc.addTransaction({ txn: tx, signer });
    await atc.execute(algorand.client.algod, 4);

    await appClient.send.managerUpdatePoolContractProgram({
      args: [program.length],
      maxFee: (100_000).microAlgo(),
      coverAppCallInnerTransactionFees: true,
      populateAppCallResources: true,
      sender,
      signer,
    });

    const programBase64 = balancedPoolApprovalProgram.compiledApproval?.compiledBase64ToBytes!;

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

    await writeGroup.send({ populateAppCallResources: true, coverAppCallInnerTransactionFees: true });
  });

  /*
  test('sum', async () => {
    const a = 13;
    const b = 37;
    const sum = await appClient.send.doMath({ args: { a, b, operation: 'sum' } });
    expect(sum.return).toBe(BigInt(a + b));
  });

  test('difference', async () => {
    const a = 13;
    const b = 37;
    const diff = await appClient.send.doMath({ args: { a, b, operation: 'difference' } });
    expect(diff.return).toBe(BigInt(a >= b ? a - b : b - a));
  });

  test('hello', async () => {
    const hello = await appClient.send.hello({ args: { name: 'world!' } });
    expect(hello.return).toBe('Hello, world!');
  });
   */
});
