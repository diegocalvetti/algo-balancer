import * as algokit from '@algorandfoundation/algokit-utils';
import BOOTSTRAP from "../../../amm/script/bootstrap.json";
import ABI_FACTORY from '../../../amm/contracts/artifacts/Factory.arc56.json';

import {FactoryClient} from "../../../amm/contracts/clients/FactoryClient";
import algosdk, {Address, AtomicTransactionComposer} from "algosdk";
import {walletManager} from "$lib/wallet";
import {WalletId} from "@txnlab/use-wallet";
import {Contract} from "$lib/contract";
import {AlgorandClient} from "@algorandfoundation/algokit-utils";

async function getAlgorand() {
  const sender = walletManager.getWallet(WalletId.MNEMONIC)?.activeAddress!
  const signer = walletManager.getWallet(WalletId.MNEMONIC)?.transactionSigner!

  const algorand = algokit.AlgorandClient.defaultLocalNet();//.setSigner(sender, signer);

  return { algorand, sender, signer }
}

type Pool = {id: number, assets: bigint[], weights: bigint[]};
export type Asset = { id: bigint, name: string, unit: string, weight?: number, icon?: string };
type DetailedPool = {id: number, assets: Asset[], weights: bigint[]};


export async function getPools(): Promise<DetailedPool[]> {
  const { algorand } = await getAlgorand();

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
  const { algorand } = await getAlgorand();
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

export async function txCreatePool(): Promise<bigint|null> {
  const { algorand } = await getAlgorand();
  const contractFactory = new Contract(algorand.client.algod, algorand.client.indexer, parseInt(BOOTSTRAP.FACTORY_ID), ABI_FACTORY)

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
  const abiType = algosdk.ABIType.from('uint64[]');
  const tokensEncoded = abiType.encode(tokens);
  const weightsEncoded = abiType.encode(weights.map(el => BigInt(el * 10 ** 16 / 100)));

  const { algorand, sender, signer } = await getAlgorand();

  const factoryClient = algorand.client.getTypedAppClientById(FactoryClient, {
    appId: BigInt(BOOTSTRAP.FACTORY_ID),
  });

  await factoryClient.send.initPool({
    args: [poolID, tokens, weights.map(el => (el/100) * 10 ** 16)],
    sender, signer,
    maxFee: (500_000).microAlgo(),
    coverAppCallInnerTransactionFees: true,
    populateAppCallResources: true,
  });
  /*
  const contractFactory = new Contract(algorand.client.algod, algorand.client.indexer, parseInt(BOOTSTRAP.FACTORY_ID), ABI_FACTORY)

  const {atc, appId} = await contractFactory.tx()
  if (!atc) throw Error("Wallet not connected")

  const factoryClient = algorand.client.getTypedAppClientById(FactoryClient, {
    appId: BigInt(BOOTSTRAP.FACTORY_ID),
  });

  contractFactory.addCall('opUp', {});

  const result = await contractFactory.addCall('initPool', {
    methodArgs: [BigInt(1148), tokensEncoded, weightsEncoded]
  }).execute();

  // @ts-ignore
  return result ? result.methodResults[0].txInfo.innerTxns[0].applicationIndex : null;
   */
}
