/* eslint-disable no-await-in-loop */
import { AlgorandFixture } from '@algorandfoundation/algokit-utils/types/testing';
import algosdk from 'algosdk';

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
  pay,
} from '../../helpers/generic';
import { deploy, writePoolProgram } from '../../helpers/factory';
import { fixedWeights, PoolTypes } from '../../helpers/pool';
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
 * Bootstrap a vault pool in batches:
 *   1. preparePool — Factory hands the pool over to the manager (admin).
 *   2. addAssets — assets are added in groups small enough to fit a 16-transaction
 *      group's resource references (each asset needs an opt-in + 3 boxes).
 *   3. finalizeBootstrap — validates the weight sum and mints the LP token.
 *
 * This is how a pool scales past the ~20 assets a single bootstrap call can
 * reference. Returns the LP token id.
 */
async function bootstrapVaultAssets(
  harness: VaultHarness,
  poolID: bigint,
  poolClient: AssetVaultClient,
  assetIds: bigint[],
  weights: number[],
  fundAlgo: number = Math.ceil(assetIds.length * 0.2) + 1
): Promise<bigint> {
  const { manager, factoryClient } = harness;
  const weightsFixed = fixedWeights(weights);

  // Fund the pool for asset opt-ins + boxes (the Factory's fixed MBR is tiny).
  await pay(manager, poolClient.appAddress, fundAlgo);

  // Hand the pool over to the manager so it can add assets directly.
  const prepPay = await getPayTx(manager, poolClient.appAddress, 1);
  await factoryClient.send.preparePool({ args: [poolID, prepPay], populateAppCallResources: true });

  // Add assets in resource-sized batches (one opUp per asset gives ample slots).
  const BATCH = 10;
  for (let start = 0; start < assetIds.length; start += BATCH) {
    const aBatch = assetIds.slice(start, start + BATCH);
    const wBatch = weightsFixed.slice(start, start + BATCH);

    const group = poolClient.newGroup();
    for (let k = 0; k < aBatch.length; k += 1) {
      group.opUp({ ...commonAppCallTxParams(manager), args: [], note: new Uint8Array([k]) });
    }
    group.addAssets({ ...commonAppCallTxParams(manager, (500_000).microAlgo()), args: [aBatch, wBatch] });
    await group.send({ populateAppCallResources: true, coverAppCallInnerTransactionFees: true });
  }

  const res = await poolClient.send.finalizeBootstrap({
    ...commonAppCallTxParams(manager, (500_000).microAlgo()),
    args: [],
  });
  return res.return as bigint;
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

  const poolClient = harness.fixture.algorand.client.getTypedAppClientById(AssetVaultClient, {
    appId: poolID,
    defaultSender: manager.sender,
    defaultSigner: manager.signer,
  });

  // Bootstrap in batches: prepare (handover) → addAssets → finalize.
  const lpId = await bootstrapVaultAssets(harness, poolID, poolClient, assetIds, weights);

  await optIn(manager, lpId);

  return { poolID, poolClient, tokensInfo, assetIds, weights, lpId };
}

/**
 * Stress variant of {@link createVaultPool} for large, equal-weighted pools.
 *
 * Mints `n` tokens and bootstraps an n-asset pool with weight 1/n each. Unlike
 * the normal helper, it funds the pool app directly before bootstrap, because
 * the Factory's fixed MBR_INIT_POOL (1 ALGO) is nowhere near enough for ~n asset
 * opt-ins plus ~2n boxes. Slow (n token deploys) — for the stress suite only.
 *
 * @param n        - Number of assets (max 100: SCALE / MIN_WEIGHT).
 * @param fundAlgo - ALGO to fund the pool with for MBR (default scales with n).
 */
export async function createLargeVaultPool(
  harness: VaultHarness,
  n: number,
  fundAlgo: number = Math.ceil(n * 0.15) + 2
): Promise<VaultPool> {
  const { manager, factoryClient } = harness;

  // Equal weights that sum to exactly SCALE: give the rounding remainder to the
  // first asset so the contract's `sum ≈ SCALE` check passes for any n.
  const base = Math.floor(10 ** 6 / n);
  const remainder = 10 ** 6 - base * n;
  const weights = Array.from({ length: n }, (_, i) => (i === 0 ? base + remainder : base) / 10 ** 6);

  const tag = `s${Date.now() % 100000}`;

  const minted: AssetInfo[] = [];
  for (let i = 0; i < n; i += 1) {
    minted.push(await createAndMintToken(manager, `${tag}_${i}`, `${tag}${i}`, BigInt(10_000_000)));
  }
  const tokensInfo = [...minted].sort((a, b) => (a.assetID < b.assetID ? -1 : 1));
  const assetIds = tokensInfo.map((t) => t.assetID);

  const payTx = await getPayTx(manager, factoryClient.appAddress, 0.1);
  const createResult = await factoryClient.send.createPool({
    args: [payTx, PoolTypes.Vault],
    populateAppCallResources: true,
  });
  const poolID = BigInt(createResult.confirmation!.innerTxns![0].applicationIndex!);

  const poolClient = harness.fixture.algorand.client.getTypedAppClientById(AssetVaultClient, {
    appId: poolID,
    defaultSender: manager.sender,
    defaultSigner: manager.signer,
  });

  // Bootstrap in batches, funding the pool for the many-asset MBR up front.
  const lpId = await bootstrapVaultAssets(harness, poolID, poolClient, assetIds, weights, fundAlgo);
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

  // Cap opUps so the group stays within the 16-transaction limit (15 opUps +
  // getLiquidity). This maximises the foreign-reference slots available.
  const numAssets = Number(await pool.poolClient.getTotalAssets());
  const opUps = Math.min(numAssets, 15);
  for (let i = 0; i < opUps; i += 1) {
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

  // A swap now touches several boxes (assetAt, balances, weights for both sides);
  // pair it with an opUp so the group has enough foreign-reference slots.
  const group = client.newGroup();
  group.opUp({ ...commonAppCallTxParams(account), args: [], note: new Uint8Array([0]) });
  group.swap({
    ...commonAppCallTxParams(account, (500_000).microAlgo()),
    args: [from, to, BigInt(minOut), xfer],
  });

  const result = await group.send(commonAppCallTxParams(account));
  const returns = result.returns!;
  return returns[returns.length - 1] as bigint;
}

/**
 * The on-chain estimateSwap (readonly), quoting the output for `amount` micro of
 * asset `from` into `to`. It runs the same pow-based math as swap, so its inner
 * increaseOpcodeBudget needs the fee covered.
 */
export async function estimateSwap(pool: VaultPool, from: number, to: number, amount: bigint): Promise<bigint> {
  const group = pool.poolClient.newGroup();
  group.opUp({ args: [], maxFee: (100_000).microAlgo(), note: new Uint8Array([0]) });
  group.opUp({ args: [], maxFee: (100_000).microAlgo(), note: new Uint8Array([1]) });
  group.estimateSwap({ args: [from, to, amount], maxFee: (500_000).microAlgo() });

  const result = await group.send({ coverAppCallInnerTransactionFees: true, populateAppCallResources: true });
  const returns = result.returns!;
  return returns[returns.length - 1] as bigint;
}

/** Burn `lpMicro` micro-LP held by `account`, redeeming the underlying assets. */
export async function burn(account: AlgoParams, pool: VaultPool, lpMicro: bigint): Promise<void> {
  const client = vaultClientFor(account, pool);
  const xfer = await makeAssetTransferTxn(account, pool.lpId, pool.poolClient.appAddress, Number(lpMicro) / 10 ** 6);

  const group = client.newGroup();
  // 14 opUps + the LP transfer + burnLiquidity = 16 (the group limit).
  const numAssets = Number(await pool.poolClient.getTotalAssets());
  const opUps = Math.min(numAssets, 14);
  for (let i = 0; i < opUps; i += 1) {
    group.opUp({ ...commonAppCallTxParams(account), args: [], note: new Uint8Array([i]) });
  }
  group.burnLiquidity({ ...commonAppCallTxParams(account, (500_000).microAlgo()), args: [xfer] });

  await group.send(commonAppCallTxParams(account));
}

/** Refund `account`'s escrowed (not-yet-minted) deposit. */
export async function cancelDeposit(account: AlgoParams, pool: VaultPool): Promise<void> {
  const client = vaultClientFor(account, pool);
  const group = client.newGroup();

  const numAssets = Number(await pool.poolClient.getTotalAssets());
  const opUps = Math.min(numAssets, 15);
  for (let i = 0; i < opUps; i += 1) {
    group.opUp({ ...commonAppCallTxParams(account), args: [], note: new Uint8Array([i]) });
  }
  group.cancelDeposit({ ...commonAppCallTxParams(account, (500_000).microAlgo()), args: [] });

  await group.send(commonAppCallTxParams(account));
}

const SEND_OPTS = { populateAppCallResources: true, coverAppCallInnerTransactionFees: true };

/** 8-byte big-endian encoding of a uint64 (matches TEALScript's itob box keys). */
function u64be(n: bigint | number): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt(n));
  return b;
}

function boxName(prefix: string, suffix: Uint8Array): Uint8Array {
  return new Uint8Array([...new TextEncoder().encode(prefix), ...suffix]);
}

/**
 * All box references a batched commitDeposit / claimBurn call touches for the
 * asset range [cursor, cursor+count). These boxes are read via box_get, which
 * returns "empty" instead of faulting when unreferenced, so resource population
 * cannot auto-discover them at a runtime-derived index — they must be named.
 */
function batchBoxes(account: AlgoParams, pool: VaultPool, prefixes: string[], cursor: number, count: number) {
  const pub = algosdk.decodeAddress(account.sender.toString()).publicKey;
  const boxes = prefixes.map((p) => ({ appId: pool.poolID, name: boxName(p, pub) }));
  boxes.push({ appId: pool.poolID, name: boxName('provided_', pub) });
  for (let i = cursor; i < cursor + count; i += 1) {
    boxes.push({ appId: pool.poolID, name: boxName('asset_', u64be(i)) });
    boxes.push({ appId: pool.poolID, name: boxName('balances_', u64be(pool.assetIds[i])) });
  }
  return boxes;
}

function pendingBoxes(account: AlgoParams, pool: VaultPool, prefixes: string[]) {
  const pub = algosdk.decodeAddress(account.sender.toString()).publicKey;
  return prefixes.map((prefix) => ({ appId: pool.poolID, name: boxName(prefix, pub) }));
}

const MINT_BOXES = ['pm_lp_', 'pm_ratio_', 'pm_cursor_'];
const BURN_BOXES = ['pb_lp_', 'pb_denom_', 'pb_cursor_'];

/**
 * Batched mint for large pools: startMint → commitDeposit (in batches) → finishMint.
 * The escrowed deposit must already be in place (via {@link provide}). Returns the
 * LP minted (micro).
 */
type BoxRef = { appId: bigint; name: Uint8Array };

/**
 * Run one batched-liquidity call in its own group, spreading `boxes` across the
 * opUp transactions (max 8 box refs per transaction; a resource referenced by any
 * transaction is available to the whole group). Returns the send result.
 */
type BatchRefs = { boxReferences: BoxRef[]; assetReferences: bigint[] };

/**
 * Run one batched-liquidity call. Boxes are NOT shared across a group (unlike
 * assets), so the ≤8 box references the call needs go on the method transaction
 * itself; a couple of plain opUps supply extra opcode budget. Population is off,
 * because it would strip explicit box refs (box_get access doesn't fault when
 * unreferenced, so population can't detect it).
 */
async function sendBatchGroup(
  client: ReturnType<typeof vaultClientFor>,
  account: AlgoParams,
  refs: BatchRefs,
  addCall: (group: ReturnType<ReturnType<typeof vaultClientFor>['newGroup']>, refs: BatchRefs) => void
) {
  const group = client.newGroup();
  group.opUp({ ...commonAppCallTxParams(account), args: [], note: new Uint8Array([0]) });
  group.opUp({ ...commonAppCallTxParams(account), args: [], note: new Uint8Array([1]) });
  addCall(group, refs);
  return group.send({ populateAppCallResources: false, coverAppCallInnerTransactionFees: true });
}

// Box refs live on the accessing transaction (max 8), so each batch is small:
// mint touches 3 pending + 1 provided + 2 per asset, leaving room for 2 assets.
export async function mintLpBatched(account: AlgoParams, pool: VaultPool, batchSize = 2): Promise<bigint> {
  const client = vaultClientFor(account, pool);
  const numAssets = Number(await pool.poolClient.getTotalAssets());
  const params = commonAppCallTxParams(account, (500_000).microAlgo());

  await sendBatchGroup(
    client,
    account,
    { boxReferences: batchBoxes(account, pool, MINT_BOXES, 0, 1), assetReferences: [pool.lpId] },
    (g, r) => g.startMint({ ...params, args: [], ...r })
  );

  for (let done = 0; done < numAssets; done += batchSize) {
    const count = Math.min(batchSize, numAssets - done);
    await sendBatchGroup(
      client,
      account,
      { boxReferences: batchBoxes(account, pool, MINT_BOXES, done, count), assetReferences: [] },
      (g, r) => g.commitDeposit({ ...params, args: [count], ...r })
    );
  }

  const result = await sendBatchGroup(
    client,
    account,
    { boxReferences: pendingBoxes(account, pool, MINT_BOXES), assetReferences: [pool.lpId] },
    (g, r) => g.finishMint({ ...params, args: [], ...r })
  );

  return result.returns![result.returns!.length - 1] as bigint;
}

/**
 * Batched burn for large pools: startBurn → claimBurn (in batches until every asset
 * is paid out).
 */
// Burn touches one extra reference per asset (the asset itself, for the transfer),
// and the per-transaction reference budget is 8 total, so it claims one asset at a time.
export async function burnBatched(account: AlgoParams, pool: VaultPool, lpMicro: bigint, batchSize = 1): Promise<void> {
  const client = vaultClientFor(account, pool);
  const numAssets = Number(await pool.poolClient.getTotalAssets());
  const params = commonAppCallTxParams(account, (500_000).microAlgo());

  const xfer = await makeAssetTransferTxn(account, pool.lpId, pool.poolClient.appAddress, Number(lpMicro) / 10 ** 6);
  await sendBatchGroup(
    client,
    account,
    { boxReferences: pendingBoxes(account, pool, BURN_BOXES), assetReferences: [pool.lpId] },
    (g, r) => g.startBurn({ ...params, args: [xfer], ...r })
  );

  for (let done = 0; done < numAssets; done += batchSize) {
    const count = Math.min(batchSize, numAssets - done);
    await sendBatchGroup(
      client,
      account,
      {
        boxReferences: batchBoxes(account, pool, BURN_BOXES, done, count),
        assetReferences: pool.assetIds.slice(done, done + count),
      },
      (g, r) => g.claimBurn({ ...params, args: [count], ...r })
    );
  }
}

/** Read a pool balance via the readonly getBalance, naming the boxes it touches. */
export async function getBalanceAt(pool: VaultPool, index: number): Promise<bigint> {
  return pool.poolClient.getBalance({
    args: [index],
    boxReferences: [
      { appId: pool.poolID, name: boxName('asset_', u64be(index)) },
      { appId: pool.poolID, name: boxName('balances_', u64be(pool.assetIds[index])) },
    ],
  });
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

// ─── Economic / accounting helpers ──────────────────────────────────────────

/** An account's holding of a given ASA, in micro units. */
export async function assetBalance(account: AlgoParams, assetId: bigint): Promise<bigint> {
  const info = await account.algorand.asset.getAccountInformation(account.sender, assetId);
  return info.balance;
}

/** The pool's internal balance for every asset, in pool order (micro units). */
export async function poolBalances(pool: VaultPool): Promise<bigint[]> {
  const numAssets = Number(await pool.poolClient.getTotalAssets());
  const out: bigint[] = [];
  for (let i = 0; i < numAssets; i += 1) {
    out.push(await pool.poolClient.getBalance({ args: [i] }));
  }
  return out;
}

/**
 * The pool's weighted-mean invariant V = Π (balance_i)^(weight_i), computed
 * off-chain in floating point. Used to check value conservation (V must grow
 * with fees and never shrink), not for exact on-chain accounting.
 */
export async function poolInvariant(pool: VaultPool): Promise<number> {
  const balances = await poolBalances(pool);
  const weights = await currentWeights(pool);

  let v = 1;
  for (let i = 0; i < balances.length; i += 1) {
    const balance = Number(balances[i]) / 10 ** 6;
    const weight = Number(weights[i]) / 10 ** 6;
    v *= balance ** weight;
  }
  return v;
}
