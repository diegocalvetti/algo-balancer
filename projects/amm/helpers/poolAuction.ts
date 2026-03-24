// eslint-disable-next-line import/no-cycle
import { AlgoParams, getPayTx, commonAppCallTxParams, getPoolClient, makeAssetTransferTxn } from './generic';
import { PoolTypes } from './pool';
import { DexPoolClient, DexPoolComposer } from '../contracts/clients/DexPoolClient';

export async function bid(config: AlgoParams, poolID: bigint, amount: number) {
  const poolClient = (await getPoolClient(config, PoolTypes.Dex, poolID)) as DexPoolClient;
  const bidPayment = await getPayTx(config, poolClient.appAddress, amount);

  return poolClient.send.bid({
    ...commonAppCallTxParams(config),
    args: [bidPayment],
    suppressLog: true,
  });
}

export async function settle(config: AlgoParams, poolID: bigint) {
  const poolClient = (await getPoolClient(config, PoolTypes.Dex, poolID)) as DexPoolClient;

  return poolClient.send.settleAuction({
    ...commonAppCallTxParams(config),
    args: [],
    suppressLog: true,
  });
}

export const claimRewards = async (
  config: AlgoParams,
  poolType: PoolTypes,
  poolID: bigint,
  lpID: bigint,
  amount: number
) => {
  const poolClient = (await getPoolClient(config, PoolTypes.Dex, poolID)) as DexPoolClient;
  const assetTransferTxn = makeAssetTransferTxn(config, lpID, poolClient.appAddress, amount);

  return poolClient.send.claimAuctionReward({
    ...commonAppCallTxParams(config),
    args: [assetTransferTxn],
    suppressLog: true,
  });
};
