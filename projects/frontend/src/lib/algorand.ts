import * as algokit from '@algorandfoundation/algokit-utils';
import BOOTSTRAP from "../../../amm/script/bootstrap.json";
import ABI_FACTORY from '../../../amm/contracts/artifacts/Factory.arc56.json';

import {FactoryClient} from "../../../amm/contracts/clients/FactoryClient";
import algosdk, {Address, AtomicTransactionComposer} from "algosdk";
import {walletManager} from "$lib/wallet";
import {WalletId} from "@txnlab/use-wallet";
import {Contract} from "$lib/contract";
import {prepareGroupForSending} from "@algorandfoundation/algokit-utils";

const algorand = algokit.AlgorandClient.defaultLocalNet();

type Pool = {id: number, assets: bigint[], weights: bigint[]};
export type Asset = { id: bigint, name: string, unit: string, weight?: number, icon?: string };
type DetailedPool = {id: number, assets: Asset[], weights: bigint[]};

const contractFactory = new Contract(algorand.client.algod, algorand.client.indexer, parseInt(BOOTSTRAP.FACTORY_ID), ABI_FACTORY)

export async function getPools(): Promise<DetailedPool[]> {
  const factoryClient = algorand.client.getTypedAppClientById(FactoryClient, {
    appId: BigInt(BOOTSTRAP.FACTORY_ID),
  });

  const boxesResponse = await algorand.client.algod.getApplicationBoxes(factoryClient.appId).do();

  const poolBoxes = boxesResponse.boxes.filter(box => {
    return new TextDecoder().decode(box.name).startsWith('pools_')
  });

  const result = [];

  for (const boxInfo of poolBoxes) {
    const box = await algorand.client.algod.getApplicationBoxByName(factoryClient.appId, boxInfo.name).do();

    const abiType = algosdk.ABIType.from('(uint64,uint64[],uint64[])')

    const decoded = abiType.decode(box.value) as ([number, number[], number[]]);

    const poolID = decoded[0];
    const assetIds = decoded[1].map(BigInt);
    const weights = decoded[2].map(BigInt);

    result.push(
      await detailPool({
        id: poolID,
        assets: assetIds,
        weights: weights
      })
    )
  }

  return result;
}

export async function detailPool(pool: Pool): Promise<DetailedPool> {
  const assets: Asset[] = [];

  for(const i in pool.assets) {
    const assetId = pool.assets[i];
    assets.push(await detailAsset(assetId, pool.weights[i]))
  }

  return {
    id: pool.id,
    weights: pool.weights,
    assets
  } as DetailedPool;
}

export async function detailAsset(assetId: bigint|string, weight: bigint|undefined = undefined): Promise<Asset> {
  if (BigInt(assetId) === BigInt(0)) {
    return {
      id: BigInt(0),
      name: "Algorand",
      unit: "ALGO",
      icon: "ALGO",
      weight: weight ? parseFloat(weight.toString()) / (10 ** 6) : undefined,
    }
  }

  const asset = await algorand.client.algod.getAssetByID(BigInt(assetId)).do();
  return {
    id: BigInt(assetId),
    name: asset.params.name!.toString(),
    unit: asset.params.unitName!.toString(),
    icon: asset.params.unitName!.toString(),
    weight: weight ? parseFloat(weight.toString()) / (10 ** 6) : undefined,
  }
}

export async function txCreatePoolTest() {
  const factoryClient = algorand.client.getTypedAppClientById(FactoryClient, {
    appId: BigInt(BOOTSTRAP.FACTORY_ID),
  });

  /*
  const group = factoryClient.newGroup();
  group.createPool({
    args: [],
    maxFee: (100_000).microAlgo(),
    sender: account.addr,
    signer: account.signer,
  });

  await group.send({ populateAppCallResources: true, coverAppCallInnerTransactionFees: true });*/
  /*

    const txs = await factoryClient.createTransaction.createPool({
      args: [],
      maxFee: (100_000).microAlgo(),
      sender: account.addr,
    });


    const txs2 = await walletManager.getWallet(WalletId.LUTE)?.signTransactions([txs.transactions[0].toByte()]);
    console.log(walletManager.getWallet(WalletId.LUTE)?.transactionSigner)
  */
  /*
  const txs = await factoryClient.createTransaction.createPool({
    args: [],
    staticFee: (400_000).microAlgo(),
    sender: account.addr,
    signer: undefined,
    boxReferences: ['pool_approval_program'],
    appReferences: [BigInt(BOOTSTRAP.POOL_ID)]
  });

  const signed = await walletManager.getWallet(WalletId.LUTE)?.signTransactions([txs.transactions[0].toByte()]);

  // @ts-ignore
  const { txid } = await algorand.client.algod.sendRawTransaction(signed).do();
  const result = await waitForConfirmation(txid, 3, algorand.client.algod);

  console.log(result);
   */

  const wallet = walletManager.getWallet(WalletId.LUTE);
  const addr = wallet?.activeAddress;
  const signer = wallet?.transactionSigner;

  const account = algorand.account.setSigner(addr!, signer!).getAccount(addr!);
  console.log('addr', account.addr);

  const group = factoryClient.newGroup();
  const comp = group.createPool({
    args: [],
    maxFee: (100_000).microAlgo(),
    sender: account.addr,
    signer: account.signer,
  });

  await comp.send({ populateAppCallResources: true, coverAppCallInnerTransactionFees: true, maxRoundsToWaitForConfirmation: 4 });
}

export async function txCreatePool(): Promise<bigint|null> {

  const {atc, appId} = await contractFactory.tx()
  if (!atc) throw Error("Wallet not connected")

  const boxKey = new Uint8Array([...new TextEncoder().encode("pool_approval_program")])

  const result = await contractFactory.addCall('createPool', {
    boxes: [{ appIndex: appId, name: boxKey }, { appIndex: appId, name: boxKey }, { appIndex: appId, name: boxKey }],
  }).execute();

  // @ts-ignore
  return result ? result.methodResults[0].txInfo.innerTxns[0].applicationIndex : null;
}

export async function txInitPool(poolID: bigint, tokens: bigint[], weights: number[]) {
  const contractFactory = new Contract(algorand.client.algod, algorand.client.indexer, parseInt(BOOTSTRAP.FACTORY_ID), ABI_FACTORY)

  const {atc, appId} = await contractFactory.tx()
  if (!atc) throw Error("Wallet not connected")

  const abiType = algosdk.ABIType.from('uint64[]');
  const tokensEncoded = abiType.encode(tokens);
  const weightsEncoded = abiType.encode(weights.map(el => BigInt(el * 10 ** 16 / 100)));

  const sender = walletManager.getWallet(WalletId.LUTE)?.activeAddress!
  const signer = walletManager.getWallet(WalletId.LUTE)?.transactionSigner!

  const factoryClient = algorand.client.getTypedAppClientById(FactoryClient, {
    appId: BigInt(BOOTSTRAP.FACTORY_ID),
    defaultSender: sender,
    defaultSigner: signer,
  });

  const group = factoryClient.newGroup();
  group.opUp({
    args: [],
    sender,
    signer,
  });

  await group.send({ populateAppCallResources: true });

  /*contractFactory.atc = await prepareGroupForSending(contractFactory.atc!, contractFactory.algod, {
    populateAppCallResources: true
  })*/
  /*
    contractFactory.addCall('opUp', {})
    await contractFactory.prepare()

    contractFactory.addCall('initPool', {
      methodArgs: [poolID, tokensEncoded, weightsEncoded],
      flatFee: true,
      fee: 500_000,
    });


  await contractFactory.execute()*/
  /*
  const txn = contractFactory.atc?.buildGroup()
  const newAtc = new AtomicTransactionComposer();
  newAtc.addTransaction({ txn: txn[0].txn, signer: walletManager.getWallet(WalletId.LUTE)?.transactionSigner! });
  */

}
