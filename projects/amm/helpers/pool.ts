import { AlgoAmount } from '@algorandfoundation/algokit-utils/types/amount';
import {
  AlgoParams,
  AssetInfo,
  commonAppCallTxParams,
  getPoolClient,
  makeAssetTransferTxn,
  optIn,
  pay,
} from './generic';
import { getTxInfo } from '../utils/bootstrap';
import { FactoryClient } from '../contracts/clients/FactoryClient';

export async function getPool(
  factoryClient: FactoryClient,
  tokens: AssetInfo[],
  weights: number[]
): Promise<bigint | undefined> {
  const weightsFixed = weights.map((el) => BigInt((el * 10 ** 6).toFixed(0).toString()));
  const result = await factoryClient.getPool({
    args: [tokens.map((el) => el.assetID), weightsFixed],
  });
  return result?.id;
}
export async function deployAndInitPool(
  factoryClient: FactoryClient,
  config: AlgoParams,
  tokens: AssetInfo[],
  weights: number[]
) {
  const tokenIds = tokens.map((el) => el.assetID);
  const weightsFixed = weights.map((el) => BigInt((el * 10 ** 6).toFixed(0).toString()));

  // Create the pool
  const result = await factoryClient.send.createPool({ args: [] });

  const tx = await getTxInfo(result.txIds[0]);
  const poolID = tx.transaction.innerTxns![0].createdApplicationIndex!;
  const poolClient = await getPoolClient(config, poolID);
  console.log(`Pool Deployed => ${poolID}`);
  await pay(config, poolClient.appAddress, 1);

  const initPoolGroup = factoryClient.newGroup();

  initPoolGroup.opUp({
    ...commonAppCallTxParams(config),
    args: [],
  });
  initPoolGroup.initPool({
    ...commonAppCallTxParams(config, (500_000).microAlgo()),
    args: [poolID, tokenIds, weightsFixed],
  });

  const resultInit = await initPoolGroup.send({
    populateAppCallResources: true,
    coverAppCallInnerTransactionFees: true,
  });

  await optIn(config, resultInit.returns[1]!);
}

export async function addLiquidity(
  factoryClient: FactoryClient,
  config: AlgoParams,
  poolID: bigint,
  token: bigint,
  index: number,
  amount: number
) {
  const poolClient = await getPoolClient(config, poolID);

  const assetTransferTxn = await makeAssetTransferTxn(config, token, poolClient.appAddress, amount);

  await factoryClient.send.addLiquidity({
    ...commonAppCallTxParams(config, (1_000_000).microAlgo()),
    args: [poolID, index, assetTransferTxn],
  });
}

export async function getLiquidity(
  factoryClient: FactoryClient,
  config: AlgoParams,
  poolID: bigint
): Promise<string[]> {
  const res = await factoryClient.send.getLiquidity({
    ...commonAppCallTxParams(config),
    args: [poolID],
  });

  return res.txIds;
}
