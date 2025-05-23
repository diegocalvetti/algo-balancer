import { OnSchemaBreak, OnUpdate } from '@algorandfoundation/algokit-utils/types/app';
import { TokenClient, TokenFactory } from '../contracts/clients/TokenClient';
import { account } from '../utils/bootstrap';
import { AlgoParams, AssetInfo, commonAppCallTxParams, optIn } from './generic';

async function deploy(config: AlgoParams, name: string): Promise<bigint> {
  const { algorand, sender, signer } = config;

  const tokenFactory = algorand.client.getTypedAppFactory(TokenFactory, {
    defaultSender: sender,
    defaultSigner: signer,
  });

  const tokenApprovalProgram = await tokenFactory.appFactory.compile();

  const appDeployer = await algorand.appDeployer.deploy({
    metadata: {
      name,
      version: '1.0.0',
      deletable: false,
      updatable: true,
    },
    createParams: {
      sender,
      signer,
      approvalProgram: tokenApprovalProgram.compiledApproval?.compiledBase64ToBytes!,
      clearStateProgram: tokenApprovalProgram.compiledClear?.compiledBase64ToBytes!,
      schema: {
        globalInts: 2,
        globalByteSlices: 1,
        localInts: 0,
        localByteSlices: 0,
      },
      extraProgramPages: 0,
    },
    updateParams: { sender: account.addr },
    deleteParams: { sender: account.addr },
    onSchemaBreak: OnSchemaBreak.AppendApp,
    onUpdate: OnUpdate.UpdateApp,
    populateAppCallResources: true,
  });

  console.log('\n\n✅ Token APP_ID IS: ', appDeployer.appId);

  return appDeployer.appId;
}

async function bootstrap(config: AlgoParams, name: string, tokenAppId: bigint): Promise<AssetInfo> {
  const { algorand, sender, signer } = config;

  const tokenClient = algorand.client.getTypedAppClientById(TokenClient, {
    appId: tokenAppId,
    defaultSender: sender,
    defaultSigner: signer,
  });

  const tx = await algorand.send.payment({
    sender,
    signer,
    receiver: tokenClient.appAddress,
    extraFee: (1_000).microAlgo(),
    amount: (1_000_000).microAlgo(),
  });

  const encoder = new TextEncoder();
  const result = await tokenClient.send.bootstrap({
    ...commonAppCallTxParams(config),
    args: { name: encoder.encode(name), unit: encoder.encode(name), seed: tx.transaction },
  });

  return {
    appID: tokenAppId,
    assetID: result.return!,
  };
}

async function mint(config: AlgoParams, asset: AssetInfo, amount: bigint): Promise<AssetInfo> {
  const { algorand, sender, signer } = config;

  const tokenClient = algorand.client.getTypedAppClientById(TokenClient, {
    appId: asset.appID,
    defaultSender: sender,
    defaultSigner: signer,
  });

  await optIn(config, asset.assetID);

  await tokenClient.send.mint({
    args: { amount: amount.algo().microAlgo },
    ...commonAppCallTxParams(config),
  });

  return asset;
}

export async function createToken(config: AlgoParams, name: string) {
  const tokenAppId = await deploy(config, name);
  return bootstrap(config, name, tokenAppId);
}

export async function mintToken(config: AlgoParams, asset: AssetInfo, amount: bigint): Promise<AssetInfo> {
  return mint(config, asset, amount);
}

export async function createAndMintToken(config: AlgoParams, name: string, amount: bigint): Promise<AssetInfo> {
  const token = await createToken(config, name);
  const assetInfo = await mintToken(config, token, amount);
  console.log(`[${name}] created => ${token.assetID}`);
  console.log(`[${name}] minted => ${amount} to ${config.sender}`);

  return assetInfo;
}
