/* eslint-disable no-console, import/no-extraneous-dependencies, no-await-in-loop, import/no-unresolved, no-return-assign */
import * as algokit from '@algorandfoundation/algokit-utils';
import dotenv from 'dotenv';

import algosdk from 'algosdk';
import { algo } from '@algorandfoundation/algokit-utils';
import { BootstrapResult, retrieveResult } from '../script/execute';
import { FactoryClient } from '../contracts/clients/FactoryClient';
import { BalancedPoolV2Client } from '../contracts/clients/BalancedPoolV2Client';
import { account } from './bootstrap';

dotenv.config();

const algorand = algokit.AlgorandClient.defaultLocalNet();

export const addLiquidity = async () => {
  const { POOL_ID, FACTORY_ID, TOKENS } = await retrieveResult<BootstrapResult>('bootstrap');

  const factoryClient = algorand.client.getTypedAppClientById(FactoryClient, {
    appId: FACTORY_ID,
    defaultSender: account.addr,
    defaultSigner: account.signer,
  });

  const poolClient = algorand.client.getTypedAppClientById(BalancedPoolV2Client, {
    appId: POOL_ID,
    defaultSender: account.addr,
    defaultSigner: account.signer,
  });

  const suggestedParams = await algorand.getSuggestedParams();

  // eslint-disable-next-line no-restricted-syntax,no-unused-vars,guard-for-in
  for (const index in TOKENS) {
    const token = TOKENS[index];
    const addLiquidityGroup = factoryClient.newGroup();

    const assetTransferTxn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
      sender: account.addr,
      suggestedParams,
      receiver: poolClient.appAddress,
      amount: 1_000_000,
      assetIndex: token,
    });

    const opt = poolClient.newGroup();
    opt.optIn({ args: [token], maxFee: (1_000_000).microAlgo() });
    await opt.send({ populateAppCallResources: true, coverAppCallInnerTransactionFees: true });

    addLiquidityGroup.addLiquidity({
      args: [POOL_ID, parseInt(index, 10), assetTransferTxn],
      maxFee: (1_000_000).microAlgo(),
    });

    await addLiquidityGroup.send({
      suppressLog: false,
      populateAppCallResources: true,
      coverAppCallInnerTransactionFees: true,
    });
  }
};
