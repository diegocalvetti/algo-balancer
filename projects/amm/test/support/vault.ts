/* eslint-disable no-await-in-loop */
import { AlgorandFixture } from '@algorandfoundation/algokit-utils/types/testing';

import { FactoryClient } from '../../contracts/clients/FactoryClient';
import { AssetVaultClient, AssetVaultFactory } from '../../contracts/clients/AssetVaultClient';
import {
  AlgoParams,
  AssetInfo,
  commonAppCallTxParams,
  getPayTx,
  getRandomAccount,
  makeAssetTransferTxn,
  optIn,
} from '../../helpers/generic';
import { deploy, writePoolProgram } from '../../helpers/factory';
import { fixedWeights, initPool, PoolTypes } from '../../helpers/pool';
import { createAndMintToken, mintToken } from '../../helpers/token';

/**
 * Shared, immutable infrastructure for a test file: a deployed Factory that
 * already holds the compiled AssetVault program. Deploy this ONCE per file
 * (in `beforeAll`); spin up a fresh {@link VaultPool} per scenario so no test
 * inherits mutable state from another.
 */
export type VaultHarness = {
  fixture: AlgorandFixture;
  manager: AlgoParams;
  factoryClient: FactoryClient;
};

/** A freshly bootstrapped vault pool plus everything a test needs to drive it. */
export type VaultPool = {
  poolID: bigint;
  poolClient: AssetVaultClient;
  /** Token metadata in pool order (index 0, 1, …). */
  tokensInfo: AssetInfo[];
  /** ASA IDs in pool order — convenience view of `tokensInfo`. */
  assetIds: bigint[];
  /** Normalised weights as passed in (e.g. [0.5, 0.5]). */
  weights: number[];
  /** The pool's LP token ASA ID. */
  lpId: bigint;
};

/**
 * Deploy a Factory and load the compiled AssetVault program into it.
 *
 * The Factory is pure infrastructure (it only stores pool bytecode), so it is
 * safe to share across every scenario in a file. The mutable state lives in the
 * pools, which {@link createVaultPool} creates fresh.
 */
export async function deployVaultFactory(fixture: AlgorandFixture): Promise<VaultHarness> {
  const manager = await getRandomAccount(fixture, 1_000_000);

  const factoryId = await deploy(manager, 'Factory');
  const factoryClient = fixture.algorand.client.getTypedAppClientById(FactoryClient, {
    appId: factoryId,
    defaultSender: manager.sender,
    defaultSigner: manager.signer,
  });

  // Fund the Factory so it can pay the box MBR for the program pages.
  await fixture.algorand.send.payment({
    sender: manager.sender,
    signer: manager.signer,
    receiver: factoryClient.appAddress,
    amount: (10).algo(),
  });

  const vaultProgram = await fixture.algorand.client
    .getTypedAppFactory(AssetVaultFactory, { defaultSender: manager.sender, defaultSigner: manager.signer })
    .appFactory.compile();

  await writePoolProgram(factoryClient, PoolTypes.Vault, vaultProgram.compiledApproval!.compiledBase64ToBytes!);

  return { fixture, manager, factoryClient };
}

/**
 * Create and bootstrap a fresh AssetVault pool with newly minted tokens.
 *
 * Unlike DEX pools, vault pools are not registered in the Factory's pool map,
 * so the pool ID is captured directly from the `createPool` inner transaction
 * (no indexer round-trip).
 *
 * @param harness  - Shared factory infrastructure from {@link deployVaultFactory}.
 * @param weights  - Normalised weights; their length sets the number of tokens.
 * @param opts.mint - Amount (whole tokens) minted to the manager per asset.
 * @param opts.tag  - Prefix for generated token names, to keep them unique.
 */
export async function createVaultPool(
  harness: VaultHarness,
  weights: number[],
  opts: { mint?: number; tag?: string } = {}
): Promise<VaultPool> {
  const { manager, factoryClient } = harness;
  const mint = BigInt(opts.mint ?? 10_000_000);
  const tag = opts.tag ?? `v${Date.now() % 100000}`;

  // Mint one token per weight, then sort by ASA ID (the Factory requires
  // ordered asset IDs at initPool).
  const minted: AssetInfo[] = [];
  for (let i = 0; i < weights.length; i += 1) {
    minted.push(await createAndMintToken(manager, `${tag}_${i}`, `${tag}${i}`, mint));
  }
  const tokensInfo = [...minted].sort((a, b) => (a.assetID < b.assetID ? -1 : 1));
  const assetIds = tokensInfo.map((t) => t.assetID);

  // Deploy the pool contract via the Factory and capture its app id from the
  // inner transaction confirmation — no indexer needed.
  const payTx = await getPayTx(manager, factoryClient.appAddress, 0.1);
  const createResult = await factoryClient.send.createPool({
    args: [payTx, PoolTypes.Vault],
    populateAppCallResources: true,
  });
  const poolID = BigInt(createResult.confirmation!.innerTxns![0].applicationIndex!);

  // Bootstrap: assign assets/weights and create the LP token.
  const lpId = await initPool(factoryClient, manager, PoolTypes.Vault, poolID, assetIds, weights);

  const poolClient = harness.fixture.algorand.client.getTypedAppClientById(AssetVaultClient, {
    appId: poolID,
    defaultSender: manager.sender,
    defaultSigner: manager.signer,
  });

  await optIn(manager, lpId);

  return { poolID, poolClient, tokensInfo, assetIds, weights, lpId };
}

// ─── Liquidity helpers ──────────────────────────────────────────────────────

/** A pool client bound to `account` as sender/signer (not the manager). */
export function vaultClientFor(account: AlgoParams, pool: VaultPool): AssetVaultClient {
  return account.algorand.client.getTypedAppClientById(AssetVaultClient, {
    appId: pool.poolID,
    defaultSender: account.sender,
    defaultSigner: account.signer,
  });
}

/**
 * Create a funded account that is opted into the pool's LP token and every
 * underlying asset, with `mint` whole tokens of each minted to it. Ready to
 * provide liquidity.
 */
export async function newProvider(harness: VaultHarness, pool: VaultPool, mint = 10_000_000): Promise<AlgoParams> {
  const account = await getRandomAccount(harness.fixture);
  await optIn(account, pool.lpId);
  for (const token of pool.tokensInfo) {
    await optIn(account, token.assetID);
    await mintToken(account, token, BigInt(mint));
  }
  return account;
}

/**
 * Deposit `amount` whole tokens of each listed asset into the pool.
 *
 * @param indices - Asset indices to provide; defaults to all (proportional add).
 *                  Pass a subset for a single-/partial-sided deposit.
 */
export async function provide(
  account: AlgoParams,
  pool: VaultPool,
  amount: number,
  indices?: number[]
): Promise<void> {
  const client = vaultClientFor(account, pool);
  const idxs = indices ?? pool.assetIds.map((_, i) => i);

  for (const index of idxs) {
    await optIn(account, pool.assetIds[index]);
    const xfer = await makeAssetTransferTxn(account, pool.assetIds[index], pool.poolClient.appAddress, amount);
    await client.send.addLiquidity({
      ...commonAppCallTxParams(account, (500_000).microAlgo()),
      args: [index, xfer],
    });
  }
}

/**
 * Mint LP tokens for liquidity already provided by `account`, returning the
 * amount minted in micro-LP (raw on-chain units).
 */
export async function mintLp(account: AlgoParams, pool: VaultPool): Promise<bigint> {
  const client = vaultClientFor(account, pool);
  const group = client.newGroup();

  const numAssets = Number(await pool.poolClient.getTotalAssets());
  for (let i = 0; i < numAssets; i += 1) {
    group.opUp({ ...commonAppCallTxParams(account), args: [], note: new Uint8Array([i]) });
  }
  group.getLiquidity({ ...commonAppCallTxParams(account), args: [] });

  const result = await group.send(commonAppCallTxParams(account));
  const returns = result.returns!;
  return returns[returns.length - 1] as bigint;
}

/** Provide `amount` of every asset and immediately mint, returning micro-LP. */
export async function provideAndMint(account: AlgoParams, pool: VaultPool, amount: number): Promise<bigint> {
  await provide(account, pool, amount);
  return mintLp(account, pool);
}

/**
 * Swap `amount` whole tokens of asset `from` for asset `to`, returning the
 * amount received in micro (raw on-chain units).
 *
 * @param minOut - Slippage guard in micro units (default 0 = accept any output).
 */
export async function swap(
  account: AlgoParams,
  pool: VaultPool,
  from: number,
  to: number,
  amount: number,
  minOut = 0
): Promise<bigint> {
  const client = vaultClientFor(account, pool);
  const xfer = await makeAssetTransferTxn(account, pool.assetIds[from], pool.poolClient.appAddress, amount);

  const result = await client.send.swap({
    ...commonAppCallTxParams(account, (500_000).microAlgo()),
    args: [from, to, BigInt(minOut), xfer],
  });

  return result.return as bigint;
}

/** Burn `lpMicro` micro-LP held by `account`, redeeming the underlying assets. */
export async function burn(account: AlgoParams, pool: VaultPool, lpMicro: bigint): Promise<void> {
  const client = vaultClientFor(account, pool);
  const xfer = await makeAssetTransferTxn(account, pool.lpId, pool.poolClient.appAddress, Number(lpMicro) / 10 ** 6);

  const group = client.newGroup();
  const numAssets = Number(await pool.poolClient.getTotalAssets());
  for (let i = 0; i < numAssets; i += 1) {
    group.opUp({ ...commonAppCallTxParams(account), args: [], note: new Uint8Array([i]) });
  }
  group.burnLiquidity({ ...commonAppCallTxParams(account, (500_000).microAlgo()), args: [xfer] });

  await group.send(commonAppCallTxParams(account));
}

// ─── Weight helpers ─────────────────────────────────────────────────────────

/**
 * Schedule a weight change. `duration === 0` applies it instantly; otherwise the
 * weights interpolate linearly over `duration` blocks.
 */
export async function changeWeights(
  account: AlgoParams,
  pool: VaultPool,
  newWeights: number[],
  duration: number
): Promise<void> {
  const client = vaultClientFor(account, pool);
  await client.send.changeWeights({
    ...commonAppCallTxParams(account),
    args: [duration, fixedWeights(newWeights)],
    suppressLog: true,
  });
}

/** Interpolated (live) weights as reported by getCurrentWeight, in pool order. */
export async function currentWeights(pool: VaultPool): Promise<bigint[]> {
  const numAssets = Number(await pool.poolClient.getTotalAssets());
  const out: bigint[] = [];
  for (let i = 0; i < numAssets; i += 1) {
    out.push(await pool.poolClient.getCurrentWeight({ args: [i] }));
  }
  return out;
}

/** Stored (committed) weights as reported by getWeight, in pool order. */
export async function storedWeights(pool: VaultPool): Promise<bigint[]> {
  const numAssets = Number(await pool.poolClient.getTotalAssets());
  const out: bigint[] = [];
  for (let i = 0; i < numAssets; i += 1) {
    out.push(await pool.poolClient.getWeight({ args: [i] }));
  }
  return out;
}

/** Current weight-transition window: [startRound, endRound, currentRound]. */
export async function poolTimes(pool: VaultPool): Promise<{ start: bigint; end: bigint; current: bigint }> {
  const t = await pool.poolClient.getTimes();
  return { start: t[0], end: t[1], current: t[2] };
}

/** Advance the chain by `n` rounds (one no-op transaction per round on LocalNet). */
export async function advanceRounds(account: AlgoParams, pool: VaultPool, n: number): Promise<void> {
  const client = vaultClientFor(account, pool);
  for (let i = 0; i < n; i += 1) {
    await client.send.opUp({
      ...commonAppCallTxParams(account),
      args: [],
      note: new Uint8Array([i]),
      suppressLog: true,
    });
  }
}
