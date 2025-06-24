import { Contract } from '@algorandfoundation/tealscript';

const TOTAL_LP_SUPPLY = 10 ** 16;
const AMOUNT_LP_DEPLOYER = 1_000_000 * 10 ** 6;
const SCALE = 1_000_000;

export class BalancedPoolV2 extends Contract {
  manager = GlobalStateKey<Address>({ key: 'manager' });

  token = GlobalStateKey<AssetID>({ key: 'token' });

  burned = GlobalStateKey<uint64>({ key: 'burned' });

  assets = GlobalStateKey<AssetID[]>({ key: 'assets' });

  weights = BoxMap<uint64, uint64>({ prefix: 'weights_' });

  targetWeights = BoxMap<uint64, uint64>({ prefix: 'target_weights_' });

  startTime = GlobalStateKey<uint64>({ key: 'start_time' });

  endTime = GlobalStateKey<uint64>({ key: 'end_time' });

  balances = BoxMap<AssetID, uint64>({ prefix: 'balances_' });

  provided = BoxMap<Address, uint64[]>({ prefix: 'provided_', dynamicSize: true });

  /**
   * Initializes global state variables when the application is first created.
   *
   * This method is automatically invoked during the application's creation call (`NoOp` with bare create).
   * It sets the initial manager to the app creator.
   *
   * This function should only be called once at contract deployment.
   */
  @allow.bareCreate('NoOp')
  createApplication() {
    this.manager.value = this.app.creator;

    this.startTime.value = 0;
    this.endTime.value = 0;
  }

  /**
   * Bootstrap the pool by assigning assets and weights, create the LP tokens.
   * @param {AssetID[]} assetIds - assets of the pool
   * @param {uint64[]} weights - weights of the pool
   * @return uint64 - LP Token created ID
   */
  bootstrap(assetIds: AssetID[], weights: uint64[]): AssetID {
    this.assertIsManager();
    assert(assetIds.length >= 2, 'At least 2 tokens needed');
    assert(assetIds.length === weights.length, 'Weights and Assets length must be the same');
    let sumOfWeights = 0;

    for (let i = 0; i < assetIds.length; i += 1) {
      this.optIn(assetIds[i]);
      this.addToken(i, assetIds[i], weights[i]);
      sumOfWeights += weights[i];
    }

    this.burned.value = 0;
    this.assets.value = assetIds;

    assert(this.absDiff(sumOfWeights, SCALE) <= 1, 'Weights must sum to 1');
    this.createToken();

    return this.token.value;
  }

  /**
   * Provide one token liquidity to the pool
   * @param {uint64} index - index of the token in the pool
   * @param {uint64} amount - amount of token sent
   * @param {Address} sender - the sender
   */
  addLiquidity(index: uint64, amount: uint64, sender: Address) {
    this.assertIsManager();
    this.assertIsBootstrapped();

    const assetId = this.assets.value[index];
    log('Asset ID => ' + itob(assetId));

    this.optIn(assetId);
    this.balances(assetId).value += amount;

    if (!this.provided(sender).exists) {
      this.provided(sender).create((this.assets.value.length + 1) * 8);
    }

    this.provided(sender).value[index] += amount;
  }

  /**
   * Mints LP tokens to the given sender based on the liquidity they provided.
   *
   * If this is the first liquidity provision (i.e., total LP supply is 0),
   * a fixed initial amount is minted to the sender. Otherwise, the amount
   * is calculated proportionally using `computeNAssetsLiquidity()`.
   *
   * After minting, the sender's "provided" state is reset.
   *
   * @param sender - The address receiving the LP tokens
   * @returns The amount of LP tokens minted
   */
  getLiquidity(sender: Address): uint64 {
    this.assertIsManager();
    this.assertIsBootstrapped();

    let amount: uint64 = 0;

    if (this.totalLP() === 0) {
      // First deployer
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
   * Burns a given amount of LP tokens from the sender and returns
   * their proportional share of each asset in the pool.
   *
   * The withdrawn amount for each asset is calculated based on the
   * ratio of `amountLP` to the total LP supply.
   *
   * @param sender - The address burning LP tokens
   * @param amountLP - The amount of LP tokens to burn
   */
  burnLiquidity(sender: Address, amountLP: uint64) {
    this.assertIsManager();
    this.assertIsBootstrapped();
    assert(amountLP > 0, 'Must burn positive amount');

    const totalLP = this.totalLP();
    const numAssets = this.assets.value.length;

    for (let i = 0; i < numAssets; i += 1) {
      const assetId = this.assets.value[i];
      const poolBalance = this.balances(assetId).value;

      const assetAmount = wideRatio([amountLP, poolBalance], [totalLP]);

      this.balances(assetId).value = poolBalance - assetAmount;

      sendAssetTransfer({
        assetReceiver: sender,
        assetAmount: assetAmount,
        xferAsset: assetId,
      });
    }

    this.burned.value += amountLP;
  }

  /**
   * Executes a weighted swap between two tokens in the pool based on the constant mean formula.
   *
   * The input token (`from`) is sent into the pool, and the output token (`to`) is sent back
   * to the sender, following the AMM's pricing curve determined by current balances and weights.
   *
   * This function performs the following steps:
   * - Retrieves the current weights and balances for the two assets.
   * - Calculates the output amount using the invariant pricing function (`calcOut`).
   * - Updates the pool's internal balances accordingly.
   * - Transfers the output asset to the sender.
   *
   * @param sender - The address initiating the swap.
   * @param from - Index of the input asset in the pool.
   * @param to - Index of the output asset in the pool.
   * @param amount - Amount of input asset to swap.
   * @returns The amount of output asset received.
   */
  swap(sender: Address, from: uint64, to: uint64, amount: uint64): uint64 {
    this.assertIsManager();
    this.assertIsBootstrapped();

    const assetIn = this.assets.value[from];
    const assetOut = this.assets.value[to];

    const balanceIn = this.balances(assetIn).value;
    const balanceOut = this.balances(assetOut).value;

    const weightIn = this.weights(from).value;
    const weightOut = this.weights(to).value;

    const amountOut = this.calcOut(balanceIn, weightIn, balanceOut, weightOut, amount);

    log(itob(amountOut));

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
   * Updates the pool's asset weights, either immediately or with a time-based linear interpolation.
   *
   * If `duration` is zero, the new weights are applied immediately by overwriting the current weights.
   * Otherwise, a linear transition is initiated from the current weights to `newWeights` over the specified
   * duration (measured in seconds or microseconds (?)).
   *
   * During the transition period, weights are dynamically computed based on the elapsed time
   * between `startTime` and `endTime`, and stored in `targetWeights`. The current weights must be
   * retrieved using a function like `getCurrentWeight()` for accurate interpolated values.
   *
   * @param {uint64[]} newWeights - Array of new target weights for each asset in the pool.
   * @param {uint64} duration - Duration of the interpolation. If 0, the weights are updated instantly.
   */
  changeWeights(duration: uint64, newWeights: uint64[]): uint64 {
    this.assertIsManager();
    this.assertIsBootstrapped();

    const currentTime = globals.latestTimestamp;

    this.startTime.value = currentTime;
    this.endTime.value = currentTime + duration;

    for (let i = 0; i < newWeights.length; i += 1) {
      this.targetWeights(i).value = newWeights[i];
    }

    return this.endTime.value;
  }

  private finalizeWeights() {
    if (globals.latestTimestamp >= this.endTime.value) {
      for (let i = 0; i < this.assets.value.length; i += 1) {
        this.weights(i).value = this.targetWeights(i).value;
      }
      this.startTime.value = 0;
      this.endTime.value = 0;
    }
  }

  /** ******************* */
  /**     SUBROUTINES     */
  /** ******************* */

  /**
   * Opts the application into a given ASA if not already opted-in.
   *
   * @param assetId - The ID of the asset to opt into.
   */
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

  /**
   * Registers a new token in the pool by initializing its balance and weight.
   *
   * This function creates and sets:
   * - A balance box for the token, initialized to 0.
   * - A weight box for the token's index, used in weighted operations like swaps.
   *
   * It assumes the caller has already validated inputs and manages order/indexing externally.
   *
   * @param index - Index of the token within the pool.
   * @param assetID - The ASA ID of the token to add.
   * @param weight - The normalized weight assigned to the token (e.g., scaled by 1e6).
   */
  private addToken(index: uint64, assetID: AssetID, weight: uint64): void {
    if (!this.weights(index).exists) {
      this.weights(index).create(8);
    }

    if (!this.balances(assetID).exists) {
      this.balances(assetID).create(8);
    }

    this.weights(index).value = weight;
    this.balances(assetID).value = 0;
  }

  /**
   * Creates the LP (liquidity provider) token for the pool if it does not already exist.
   *
   * The LP token is an Algorand Standard Asset (ASA) that represents a user's proportional
   * share of the pool.
   * This function ensures only one token is created, and sets the contract
   * as its manager and reserve.
   *
   * The token is configured with:
   * - Total supply: `TOTAL_LP_SUPPLY`
   * - Decimals: 6
   * - Reserve: this contract's address
   * - No clawback/freeze addresses
   * - Default frozen: false
   *
   * The Token name is dynamically derived from the application ID.
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

  /**
   * Assert the tx sender is the manager
   */
  private assertIsManager(): void {
    assert(this.txn.sender === this.manager.value, 'only the manager can call this method');
  }

  private assertIsBootstrapped(): void {
    assert(this.token.value !== AssetID.zeroIndex, 'pool not bootstrapped');
  }

  /**
   * Approximates the natural logarithm of a fixed-point value `x` with sign support.
   *
   * Uses a rational approximation of ln(x) via the Mercator series, centered around 1.
   * If `x < SCALE`, the logarithm of the inverse is computed and a `negative` flag is returned.
   * This is used to handle values less than 1 while keeping precision stable.
   *
   * @param x - Input value in fixed-point representation (scaled by SCALE).
   * @returns A tuple [negative: uint64, result: uint64] where:
   *          - negative = 1 if log(x) is negative
   *          - result = absolute value of log(x) scaled by SCALE
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

    let result = z;
    let term = z;
    let neg = false;

    increaseOpcodeBudget();

    for (let i = 2; i <= 10; i = i + 1) {
      term = wideRatio([term, z], [SCALE]);
      const delta = wideRatio([term], [i]);
      result = neg ? result - delta : result + delta;
      neg = !neg;
    }

    return [negative, result];
  }

  /**
   * Approximates the exponential function e^x for a fixed-point input.
   *
   * Uses a truncated Taylor series expansion of e^x:
   *     e^x ≈ 1 + x + x^2/2! + x^3/3! + ... + x^n/n!
   *
   * @param x - Exponent in fixed-point representation (scaled by SCALE).
   * @returns Approximated e^x value in fixed-point representation.
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
   * Approximates x rise to the power of y (i.e., x^y) in fixed-point arithmetic.
   *
   * Internally implemented using:
   *   x^y = exp(y * ln(x))
   * Handles x < 1 via sign-aware logarithm and inversion logic.
   *
   * @param x - Base value in fixed-point representation.
   * @param y - Exponent in fixed-point representation.
   * @returns Approximated result of x^y in fixed-point.
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
   * Calculates the output amount of a token swap using the constant mean formula
   * with weight-based pricing and an optional fee.
   *
   * The formula used is derived from the Balancer-style AMM:
   *
   *   amountOut = balanceOut * (1 - (balanceIn / (balanceIn + amountInWithFee))^(weightIn / weightOut))
   *
   * This ensures price sensitivity based on both token weights and pool balances.
   * A swap fee is applied by reducing the effective input amount.
   *
   * @param balanceIn - Current balance of the input asset in the pool.
   * @param weightIn - Weight of the input asset, scaled by SCALE.
   * @param balanceOut - Current balance of the output asset in the pool.
   * @param weightOut - Weight of the output asset, scaled by SCALE.
   * @param amountIn - Amount of input asset sent by the user.
   * @returns The amount of output asset the user will receive.
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

    // x / (x + Dx - f)
    const ratio = wideRatio([balanceIn, SCALE], [balanceIn + amountInWithFee]);

    const power = wideRatio([weightIn, SCALE], [weightOut]);

    // output = balanceOut * (1 - ratio^power)
    const ratioPow = this.pow(ratio, power);

    log(itob(balanceIn));
    log(itob(amountInWithFee));
    log(itob(ratio));
    log(itob(power));
    log(itob(ratioPow));
    log(itob(wideRatio([balanceOut, SCALE - ratioPow], [SCALE])));

    return wideRatio([balanceOut, SCALE - ratioPow], [SCALE]);
  }

  /**
   * Computes the amount of LP tokens to mint for a user based on the assets they provided,
   * using the constant mean formula with weight sensitivity.
   *
   * This method calculates the geometric mean of each provided asset relative to the pool's balance,
   * adjusted by its weight. The formula is:
   *
   * liquidity = totalLP * Π_i (provided_i / (balance_i - provided_i)) ^ weight_i
   *
   * It ensures proportional liquidity provisioning across all assets, weighted appropriately.
   * The liquidity amount is scaled by the product of powered ratios and the total LP supply.
   *
   * During execution, this function also resets the sender's `provided` vector to zero,
   * consuming the state used to compute the liquidity. This ensures the same input
   * cannot be reused in future calculations.
   *
   * @param sender - The user address for which liquidity is being computed.
   * @returns The amount of LP tokens to mint for the sender.
   */
  private computeNAssetsLiquidity(sender: Address): uint64 {
    const totalAssets = this.assets.value.length;
    assert(totalAssets >= 1, 'Please provide at least one asset');

    let ratio = SCALE;

    for (let i = 0; i < totalAssets - 1; i += 1) {
      increaseOpcodeBudget();
    }

    for (let i = 0; i < totalAssets; i += 1) {
      const assetId = this.assets.value[i];
      const poolBalance = this.balances(assetId).value;
      const providedAmount = this.provided(sender).value[i];
      const weight = this.weights(i).value;

      assert(poolBalance > 0, 'Pool balance must be > 0');

      const assetRatio = wideRatio([providedAmount, SCALE], [poolBalance - providedAmount]);
      const powed = this.pow(assetRatio, weight);
      ratio = wideRatio([ratio, powed], [SCALE]);

      this.provided(sender).value[i] = 0;
    }

    const totalLP = this.totalLP();
    return wideRatio([totalLP, ratio], [SCALE]);
  }

  /**
   * Returns the total circulating supply of LP tokens in the pool.
   *
   * Circulating LP supply is calculated as:
   *   totalIssued - reserveBalance - burned
   *
   * - `totalIssued`: the total supply originally created by the pool.
   * - `reserveBalance`: LP tokens still held in the reserve (i.e., the pool itself).
   * - `burned`: total LP tokens permanently removed via `burnLiquidity()`.
   *
   * This value is used in proportional calculations such as minting or burning LP tokens.
   *
   * @returns The current total circulating LP token supply.
   */
  private totalLP(): uint64 {
    return this.token.value.total - this.token.value.reserve.assetBalance(this.token.value) - this.burned.value;
  }

  /**
   * Returns the absolute difference between two unsigned integers.
   *
   * Equivalent to:
   *   |a - b| = (a > b) ? a - b : b - a
   *
   * Useful in cases where the ordering of values is uncertain, but the magnitude
   * of their difference is important (e.g., weight normalization tolerances).
   *
   * @param a - First value.
   * @param b - Second value.
   * @returns The absolute difference between `a` and `b`.
   */
  private absDiff(a: uint64, b: uint64): uint64 {
    return a > b ? a - b : b - a;
  }

  @abi.readonly
  getTotalAssets(): uint64 {
    return this.assets.value.length;
  }

  @abi.readonly
  getToken(): AssetID {
    return this.token.value;
  }

  @abi.readonly
  getBalance(index: uint64): uint64 {
    const asset = this.assets.value[index];
    return this.balances(asset).value;
  }

  @abi.readonly
  estimateSwap(from: uint64, to: uint64, amount: uint64): uint64 {
    const assetIn = this.assets.value[from];
    const assetOut = this.assets.value[to];

    const balanceIn = this.balances(assetIn).value;
    const balanceOut = this.balances(assetOut).value;

    const weightIn = this.weights(from).value;
    const weightOut = this.weights(to).value;

    return this.calcOut(balanceIn, weightIn, balanceOut, weightOut, amount);
  }

  @abi.readonly
  getCurrentWeight(index: uint64): uint64 {
    const now = globals.latestTimestamp;
    const start = this.startTime.value;
    const end = this.endTime.value;

    log(itob(now));
    log(itob(start));
    log(itob(end));

    if (now <= start || start === 0 || end === 0) {
      return this.weights(index).value;
    }

    if (now >= end) {
      return this.targetWeights(index).value;
    }

    const elapsed = now - start;
    const total = end - start;

    const w0 = this.weights(index).value;
    const w1 = this.targetWeights(index).value;

    const delta = w1 > w0 ? w1 - w0 : w0 - w1;
    const offset = wideRatio([delta, elapsed], [total]);

    return w1 > w0 ? w0 + offset : w0 - offset;
  }

  @abi.readonly
  getTimes(): uint64[] {
    return [this.startTime.value, this.endTime.value, globals.latestTimestamp];
  }
}
