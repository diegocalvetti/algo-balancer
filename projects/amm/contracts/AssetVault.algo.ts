import { Contract } from '@algorandfoundation/tealscript';

/** Total LP supply minted at token creation; circulating supply is tracked separately. */
const TOTAL_LP_SUPPLY = 10 ** 16;
/** LP minted to the very first liquidity provider, which sets the initial supply. */
const AMOUNT_LP_DEPLOYER = 1_000_000 * 10 ** 6;
/** Fixed-point scale: weights and ratios are expressed as integers out of SCALE (1.0). */
const SCALE = 1_000_000;
/** Minimum weight per asset (1% of SCALE). Caps the pool at SCALE / MIN_WEIGHT = 100 assets. */
const MIN_WEIGHT = 10_000;

/**
 * Weighted constant-mean AMM pool (Balancer-style) holding up to 100 assets.
 *
 * Pricing follows the weighted invariant V = Π balance_i^weight_i. Weights can be
 * changed instantly or interpolated linearly over a block window. The pool is
 * bootstrapped in batches (prepare → addAssets → finalizeBootstrap) so it can
 * scale to many assets, then accepts proportional liquidity and weighted swaps.
 */
export class AssetVault extends Contract {
  /** Account allowed to call admin methods (e.g. changeWeights). */
  manager = GlobalStateKey<Address>({ key: 'manager' });

  /** LP token ASA. Zero until finalizeBootstrap; non-zero means the pool is live. */
  token = GlobalStateKey<AssetID>({ key: 'token' });

  burned = GlobalStateKey<uint64>({ key: 'burned' });

  /** Asset list as one box per index. (A global array would cap the pool at ~15 assets.) */
  assetAt = BoxMap<uint64, AssetID>({ prefix: 'asset_' });

  /** Number of assets currently registered. */
  numAssets = GlobalStateKey<uint64>({ key: 'num_assets' });

  /** Current weight per asset index (scaled by SCALE). */
  weights = BoxMap<uint64, uint64>({ prefix: 'weights_' });

  /** Destination weights during an interpolated weight change. */
  targetWeights = BoxMap<uint64, uint64>({ prefix: 'target_weights_' });

  /** First/last round of the active weight interpolation; both 0 when none is running. */
  startRound = GlobalStateKey<uint64>({ key: 'start_round' });

  endRound = GlobalStateKey<uint64>({ key: 'end_round' });

  /** Pool balance per asset, tracked internally rather than read from holdings. */
  balances = BoxMap<AssetID, uint64>({ prefix: 'balances_' });

  /** Per-provider amounts deposited but not yet converted to LP (one slot per asset). */
  provided = BoxMap<Address, uint64[]>({ prefix: 'provided_', dynamicSize: true });

  /** Running weight total accumulated during bootstrap, checked against SCALE at finalize. */
  weightSumAccum = GlobalStateKey<uint64>({ key: 'weight_sum' });

  /** Highest AssetID added so far; enforces strictly-increasing order across batches. */
  lastAsset = GlobalStateKey<AssetID>({ key: 'last_asset' });

  /** Sets the manager to the creator. Bare create, called once at deployment. */
  @allow.bareCreate('NoOp')
  createApplication() {
    this.manager.value = this.app.creator;

    this.startRound.value = 0;
    this.endRound.value = 0;
  }

  /**
   * Begin bootstrapping: hand the pool over to `admin` and reset asset state.
   *
   * Called by the Factory (still the manager at this point). The admin then fills
   * the pool with one or more {@link addAssets} batches and closes it with
   * {@link finalizeBootstrap}. Batching keeps each transaction's resource
   * references within the per-group limit, so the pool can hold many assets.
   *
   * @param admin - account that becomes the pool manager.
   */
  prepare(admin: Address): void {
    this.assertIsManager();

    this.manager.value = admin;
    this.numAssets.value = 0;
    this.weightSumAccum.value = 0;
    this.lastAsset.value = AssetID.zeroIndex;
    this.burned.value = 0;
  }

  /**
   * Append a batch of assets and weights during bootstrap. Manager-only, and only
   * before {@link finalizeBootstrap}. May be called repeatedly; AssetIDs must be
   * strictly increasing across all batches. Weights accumulate and are validated
   * at finalize.
   *
   * @param assets  - ASA IDs for this batch (strictly increasing).
   * @param weights - Weight per asset, each >= MIN_WEIGHT.
   */
  addAssets(assets: AssetID[], weights: uint64[]): void {
    this.assertIsManager();
    assert(this.token.value === AssetID.zeroIndex, 'pool already bootstrapped');
    assert(assets.length === weights.length, 'assets and weights length mismatch');

    // Each asset costs an opt-in plus box writes; raise the opcode budget to match.
    for (let b = 0; b < assets.length / 4 + 1; b += 1) {
      increaseOpcodeBudget();
    }

    for (let i = 0; i < assets.length; i += 1) {
      assert(weights[i] >= MIN_WEIGHT, 'weight too small');
      assert(assets[i] > this.lastAsset.value, 'assets must be strictly increasing');

      const index = this.numAssets.value;
      this.optIn(assets[i]);
      this.addToken(index, assets[i], weights[i]);

      this.weightSumAccum.value = this.weightSumAccum.value + weights[i];
      this.lastAsset.value = assets[i];
      this.numAssets.value = index + 1;
    }

    assert(this.numAssets.value <= SCALE / MIN_WEIGHT, 'too many tokens');
  }

  /**
   * Close bootstrapping: require the weights to sum to SCALE and mint the LP token.
   * The pool is live (accepts liquidity) afterwards. Manager-only.
   *
   * @returns the LP token AssetID.
   */
  finalizeBootstrap(): AssetID {
    this.assertIsManager();
    assert(this.token.value === AssetID.zeroIndex, 'pool already bootstrapped');
    assert(this.numAssets.value >= 1, 'no assets added');
    assert(this.absDiff(this.weightSumAccum.value, SCALE) <= 1, 'weights must sum to 1');

    this.createToken();

    return this.token.value;
  }

  /**
   * Deposit one asset toward a liquidity position. The amount is held in `provided`
   * until {@link getLiquidity} converts the full position into LP tokens.
   *
   * @param index - index of the deposited asset in the pool.
   * @param txn   - asset transfer carrying the deposit.
   */
  addLiquidity(index: uint64, txn: AssetTransferTxn) {
    this.assertIsBootstrapped();
    this.tryFinalizeWeights();

    const sender = txn.sender;
    const amount = txn.assetAmount;

    const assetId = this.assetAt(index).value;

    this.optIn(assetId);
    this.balances(assetId).value += amount;

    if (!this.provided(sender).exists) {
      this.provided(sender).create((this.numAssets.value + 1) * 8);
    }

    this.provided(sender).value[index] += amount;
  }

  /**
   * Mint LP tokens for the sender's pending deposits, then clear them.
   *
   * The first provider receives a fixed amount (AMOUNT_LP_DEPLOYER) and must seed
   * every asset. Subsequent providers receive an amount proportional to the value
   * they add, via {@link computeNAssetsLiquidity}.
   *
   * @returns the amount of LP tokens minted.
   */
  getLiquidity(): uint64 {
    this.assertIsBootstrapped();
    this.tryFinalizeWeights();

    const sender = this.txn.sender;
    let amount: uint64 = 0;

    if (this.totalLP() === 0) {
      // First deposit sets the initial pool; every asset must be seeded so the
      // pool never starts with a zero balance (which would break swaps and joins).
      for (let i = 0; i < this.numAssets.value; i += 1) {
        assert(this.balances(this.assetAt(i).value).value > 0, 'first deposit must seed every asset');
      }
      amount = AMOUNT_LP_DEPLOYER;
    } else {
      amount = this.computeNAssetsLiquidity(sender);
    }

    for (let i = 0; i < this.provided(sender).value.length; i += 1) {
      this.provided(sender).value[i] = 0;
    }

    sendAssetTransfer({
      assetReceiver: sender,
      assetAmount: amount,
      xferAsset: this.token.value,
    });

    return amount;
  }

  /**
   * Burn LP tokens and return the holder's proportional share of every asset.
   *
   * @param transferTxn - LP transfer into the pool; its amount is the LP burned.
   */
  burnLiquidity(transferTxn: AssetTransferTxn) {
    this.assertIsBootstrapped();
    this.tryFinalizeWeights();

    const sender = this.txn.sender;
    const amountLP = transferTxn.assetAmount;

    assert(amountLP > 0, 'Must burn positive amount');

    // Redeem against the supply circulating before this burn. The incoming LP is
    // already in the reserve (so totalLP() excludes it); add it back as the denominator.
    const totalLP = this.totalLP() + amountLP;
    const numAssets = this.numAssets.value;

    for (let i = 0; i < numAssets; i += 1) {
      const assetId = this.assetAt(i).value;
      const poolBalance = this.balances(assetId).value;

      const assetAmount = wideRatio([amountLP, poolBalance], [totalLP]);

      this.balances(assetId).value = poolBalance - assetAmount;

      sendAssetTransfer({
        assetReceiver: sender,
        assetAmount: assetAmount,
        xferAsset: assetId,
      });
    }
  }

  /**
   * Swap `from` for `to` along the weighted constant-mean curve.
   *
   * The input asset is sent into the pool, the output asset back to the sender.
   * Reverts if the computed output is below `minAmountOut` (slippage guard).
   *
   * @param from         - index of the input asset.
   * @param to           - index of the output asset.
   * @param minAmountOut - minimum acceptable output.
   * @param transferTxn  - asset transfer carrying the input amount.
   * @returns the output amount sent to the sender.
   */
  swap(from: uint64, to: uint64, minAmountOut: uint64, transferTxn: AssetTransferTxn): uint64 {
    this.assertIsBootstrapped();
    this.tryFinalizeWeights();
    increaseOpcodeBudget();

    const sender = transferTxn.sender;
    const amount = transferTxn.assetAmount;

    const assetIn = this.assetAt(from).value;
    const assetOut = this.assetAt(to).value;

    const balanceIn = this.balances(assetIn).value;
    const balanceOut = this.balances(assetOut).value;

    const weightIn = this.getCurrentWeight(from);
    const weightOut = this.getCurrentWeight(to);

    const amountOut = this.calcOut(balanceIn, weightIn, balanceOut, weightOut, amount);

    assert(amountOut >= minAmountOut, 'Slippage exceeded');

    this.balances(assetIn).value = balanceIn + amount;
    this.balances(assetOut).value = balanceOut - amountOut;

    sendAssetTransfer({
      assetReceiver: sender,
      assetAmount: amountOut,
      xferAsset: assetOut,
    });

    return amountOut;
  }

  /**
   * Change the pool's weights. Manager-only; rejected while a transition is active.
   *
   * With `duration === 0` the new weights apply immediately. Otherwise they
   * interpolate linearly from the current weights to `newWeights` over `duration`
   * blocks; during the transition {@link getCurrentWeight} returns the live value.
   *
   * @param duration   - interpolation length in blocks (0 = instant).
   * @param newWeights - target weight per asset (each >= MIN_WEIGHT, summing to SCALE).
   * @returns the round at which the transition ends (0 if instant).
   */
  changeWeights(duration: uint64, newWeights: uint64[]): uint64 {
    this.assertIsManager();
    this.assertIsBootstrapped();
    this.assertNoWeightTransition();

    assert(newWeights.length === this.numAssets.value, 'weights length must match assets');

    let sumOfWeights: uint64 = 0;
    for (let i = 0; i < newWeights.length; i += 1) {
      assert(newWeights[i] >= MIN_WEIGHT, 'weight too small');
      sumOfWeights += newWeights[i];
    }
    assert(this.absDiff(sumOfWeights, SCALE) <= 1, 'weights must sum to 1');

    if (duration === 0) {
      this.startRound.value = 0;
      this.endRound.value = 0;
      for (let i = 0; i < newWeights.length; i += 1) {
        this.weights(i).value = newWeights[i];
      }
    } else {
      const currentRound = globals.round;

      this.startRound.value = currentRound;
      this.endRound.value = currentRound + duration;

      for (let i = 0; i < newWeights.length; i += 1) {
        this.targetWeights(i).value = newWeights[i];
      }
    }

    return this.endRound.value;
  }

  addAsset(asset: AssetID, w: uint64): uint64 {
    const newIndex = this.numAssets.value;

    if (!this.assetAt(newIndex).exists) {
      this.assetAt(newIndex).create(8);
    }
    this.assetAt(newIndex).value = asset;

    for (let i = 0; i < newIndex; i += 1) {
      this.weights(i).value = this.weights(i).value * (SCALE - w);
    }

    if (!this.weights(newIndex).exists) {
      this.weights(newIndex).create(8);
    }
    this.weights(newIndex).value = w;

    this.numAssets.value = newIndex + 1;

    return w;
  }

  /** Commit a finished weight interpolation into the stored weights. */
  private tryFinalizeWeights() {
    if (this.endRound.value !== 0 && globals.round >= this.endRound.value) {
      for (let i = 0; i < this.numAssets.value; i += 1) {
        this.weights(i).value = this.targetWeights(i).value;
      }
      this.startRound.value = 0;
      this.endRound.value = 0;
    }
  }

  /** ******************* */
  /**     SUBROUTINES     */
  /** ******************* */

  /** Opt the app into an ASA if it is not already opted in. */
  private optIn(assetId: AssetID): void {
    if (this.app.address.isOptedInToAsset(assetId)) {
      return;
    }

    sendAssetTransfer({
      assetReceiver: this.app.address,
      xferAsset: assetId,
      assetAmount: 0,
    });
  }

  /** Create the asset/weight/balance boxes for one token at `index`. */
  private addToken(index: uint64, assetID: AssetID, weight: uint64): void {
    if (!this.assetAt(index).exists) {
      this.assetAt(index).create(8);
    }

    if (!this.weights(index).exists) {
      this.weights(index).create(8);
    }

    if (!this.balances(assetID).exists) {
      this.balances(assetID).create(8);
    }

    this.assetAt(index).value = assetID;
    this.weights(index).value = weight;
    this.balances(assetID).value = 0;
  }

  /**
   * Create the pool's LP token (once). It is an ASA with this contract as manager
   * and reserve, 6 decimals, and no clawback/freeze. Held in reserve and released
   * as liquidity is minted.
   */
  private createToken(): void {
    if (this.token.value === AssetID.zeroIndex) {
      this.token.value = sendAssetCreation({
        configAssetTotal: TOTAL_LP_SUPPLY,
        configAssetDecimals: 6,
        configAssetReserve: this.app.address,
        configAssetManager: this.app.address,
        configAssetClawback: globals.zeroAddress,
        configAssetFreeze: globals.zeroAddress,
        configAssetDefaultFrozen: 0,
        configAssetName: 'BalancedPool-' + this.app.id.toString(),
        configAssetUnitName: 'LP',
      });
    }
  }

  private assertIsManager(): void {
    assert(this.txn.sender === this.manager.value, 'only the manager can call this method');
  }

  private assertIsBootstrapped(): void {
    assert(this.token.value !== AssetID.zeroIndex, 'pool not bootstrapped');
  }

  private assertNoWeightTransition(): void {
    assert(this.startRound.value === 0 && this.startRound.value === this.endRound.value);
  }

  /**
   * Fixed-point ln(x) via the Mercator series around 1, with a sign flag.
   * For x < 1 it computes ln(1/x) and flags the result negative, keeping precision.
   *
   * @param x - value scaled by SCALE (must be > 0).
   * @returns [negative, |ln(x)| scaled by SCALE], negative = 1 when ln(x) < 0.
   */
  private lnWithSign(x: uint64): uint64[] {
    assert(x > 0, 'log undefined for x ≤ 0');

    let negative: uint64 = 0;
    let z: uint64;

    if (x < SCALE) {
      negative = 1;
      const invX = wideRatio([SCALE, SCALE], [x]);
      z = wideRatio([invX - SCALE, SCALE], [invX]);
    } else {
      z = wideRatio([x - SCALE, SCALE], [x]);
    }

    // ln(x) = z + z^2/2 + z^3/3 + ... for z = (x-1)/x (all terms positive).
    let result = z;
    let term = z;

    increaseOpcodeBudget();

    for (let i = 2; i <= 10; i = i + 1) {
      term = wideRatio([term, z], [SCALE]);
      result = result + wideRatio([term], [i]);
    }

    return [negative, result];
  }

  /**
   * Fixed-point e^x via a 10-term Taylor series.
   *
   * @param x - exponent scaled by SCALE.
   * @returns e^x scaled by SCALE.
   */
  private exp(x: uint64): uint64 {
    let result = SCALE;
    let term = SCALE;

    for (let i = 1; i <= 10; i = i + 1) {
      term = wideRatio([term, x], [i * SCALE]);
      result += term;
    }

    return result;
  }

  /**
   * Fixed-point x^y, computed as exp(y * ln(x)) with sign-aware ln for x < 1.
   * Accuracy degrades for ratios far from 1 (series truncation).
   *
   * @param x - base scaled by SCALE.
   * @param y - exponent scaled by SCALE.
   * @returns x^y scaled by SCALE.
   */
  private pow(x: uint64, y: uint64): uint64 {
    if (x === 0) return 0;

    const lnXResult = this.lnWithSign(x);
    const negativeLn = lnXResult[0];
    const lnX = lnXResult[1];

    const ylnX = wideRatio([y, lnX], [SCALE]);

    const expResult = this.exp(ylnX);

    if (negativeLn === 1) {
      return wideRatio([SCALE, SCALE], [expResult]);
    }

    return expResult;
  }

  /**
   * Weighted constant-mean swap output, with a swap fee on the input:
   *
   *   amountOut = balanceOut * (1 - (balanceIn / (balanceIn + amountInWithFee)) ^ (weightIn / weightOut))
   *
   * @param balanceIn  - input asset balance.
   * @param weightIn   - input asset weight (scaled by SCALE).
   * @param balanceOut - output asset balance.
   * @param weightOut  - output asset weight (scaled by SCALE).
   * @param amountIn   - input amount sent by the user.
   * @returns the output amount.
   */
  private calcOut(
    balanceIn: uint64,
    weightIn: uint64,
    balanceOut: uint64,
    weightOut: uint64,
    amountIn: uint64
  ): uint64 {
    const fee = 1_000;

    const amountInWithFee = wideRatio([amountIn, SCALE - fee], [SCALE]);

    const ratio = wideRatio([balanceIn, SCALE], [balanceIn + amountInWithFee]);

    const power = wideRatio([weightIn, SCALE], [weightOut]);

    const ratioPow = this.pow(ratio, power);

    return wideRatio([balanceOut, SCALE - ratioPow], [SCALE]);
  }

  /**
   * LP to mint for a proportional deposit.
   *
   * Every asset must grow by the same fraction k of its balance (within 0.5%),
   * otherwise the deposit is not invariant-preserving and is rejected — this also
   * blocks single-sided deposits. Because the deposit grows the invariant by
   * (1 + k) and Σ weights = 1, the LP supply must grow by exactly k:
   *
   *   minted = totalLP * k
   *
   * This is linear and exact — no per-asset pow is needed once proportionality is
   * enforced. Clears the sender's `provided` slots as it reads them.
   *
   * @param sender - the provider whose deposit is being priced.
   * @returns the LP amount to mint.
   */
  private computeNAssetsLiquidity(sender: Address): uint64 {
    const totalAssets = this.numAssets.value;
    assert(totalAssets >= 1, 'Please provide at least one asset');

    let referenceRatio: uint64 = 0;

    for (let i = 0; i < totalAssets; i += 1) {
      const assetId = this.assetAt(i).value;
      const poolBalance = this.balances(assetId).value;
      const providedAmount = this.provided(sender).value[i];

      assert(poolBalance > 0, 'Pool balance must be > 0');

      // Fraction by which this asset's balance grows.
      const assetRatio = wideRatio([providedAmount, SCALE], [poolBalance - providedAmount]);

      // All assets must grow by the same fraction (0.5% tolerance for rounding).
      if (i === 0) {
        referenceRatio = assetRatio;
      } else {
        assert(
          this.absDiff(assetRatio, referenceRatio) <= referenceRatio / 200,
          'deposit must be proportional to pool balances'
        );
      }

      this.provided(sender).value[i] = 0;
    }

    return wideRatio([this.totalLP(), referenceRatio], [SCALE]);
  }

  /** Circulating LP supply: total issued, minus the reserve, minus burned. */
  private totalLP(): uint64 {
    return this.token.value.total - this.token.value.reserve.assetBalance(this.token.value) - this.burned.value;
  }

  /** |a - b| for unsigned integers. */
  private absDiff(a: uint64, b: uint64): uint64 {
    return a > b ? a - b : b - a;
  }

  @abi.readonly
  getTotalAssets(): uint64 {
    return this.numAssets.value;
  }

  @abi.readonly
  getToken(): AssetID {
    return this.token.value;
  }

  @abi.readonly
  getWeight(index: uint64): uint64 {
    return this.weights(index).value;
  }

  @abi.readonly
  getBalance(index: uint64): uint64 {
    const asset = this.assetAt(index).value;
    return this.balances(asset).value;
  }

  @abi.readonly
  estimateSwap(from: uint64, to: uint64, amount: uint64): uint64 {
    const assetIn = this.assetAt(from).value;
    const assetOut = this.assetAt(to).value;

    const balanceIn = this.balances(assetIn).value;
    const balanceOut = this.balances(assetOut).value;

    const weightIn = this.getCurrentWeight(from);
    const weightOut = this.getCurrentWeight(to);

    return this.calcOut(balanceIn, weightIn, balanceOut, weightOut, amount);
  }

  /** Current weight of an asset, interpolated if a weight transition is active. */
  @abi.readonly
  getCurrentWeight(index: uint64): uint64 {
    const current = globals.round;
    const start = this.startRound.value;
    const end = this.endRound.value;

    if (current <= start || start === 0 || end === 0) {
      return this.weights(index).value;
    }

    if (current >= end) {
      return this.targetWeights(index).value;
    }

    const elapsed = current - start;
    const total = end - start;

    const w0 = this.weights(index).value;
    const w1 = this.targetWeights(index).value;

    const delta = w1 > w0 ? w1 - w0 : w0 - w1;
    const offset = wideRatio([delta, elapsed], [total]);

    return w1 > w0 ? w0 + offset : w0 - offset;
  }

  @abi.readonly
  getTimes(): uint64[] {
    return [this.startRound.value, this.endRound.value, globals.round];
  }

  opUp(): void {}
}
