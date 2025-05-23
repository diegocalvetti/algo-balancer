import { AlgorandClient } from '@algorandfoundation/algokit-utils';
import algosdk, { Address, AtomicTransactionComposer, TransactionSigner } from 'algosdk';
import { AlgoAmount } from '@algorandfoundation/algokit-utils/types/amount';
import { AlgorandFixture } from '@algorandfoundation/algokit-utils/types/testing';
import { FactoryClient } from '../contracts/clients/FactoryClient';
import { BalancedPoolV2Client } from '../contracts/clients/BalancedPoolV2Client';

export type AssetInfo = {
  appID: bigint;
  assetID: bigint;
};

export type AlgoParams = {
  algorand: AlgorandClient;
  sender: string;
  signer: TransactionSigner;
};

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

export async function getFactoryClient(params: AlgoParams, id: number) {
  const { algorand, sender, signer } = params;

  algorand.client.getTypedAppClientById(FactoryClient, {
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
  fixture.context.testAccount = await fixture.context.generateAccount({ initialFunds: fund.algo() });

  return {
    algorand: fixture.algorand,
    sender: fixture.context.testAccount.addr.toString(),
    signer: fixture.context.testAccount.signer,
  };
}
