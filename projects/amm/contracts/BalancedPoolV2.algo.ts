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

  balances = BoxMap<AssetID, uint64>({ prefix: 'balances_' });

  provided = BoxMap<Address, uint64[]>({ prefix: 'provided_', dynamicSize: true });

  /**
   * createApplication method called at creation
   */
  @allow.bareCreate('NoOp')
  createApplication() {
    this.manager.value = this.app.creator;
    this.burned.value = 0;
  }

  /**
   * Bootstrap the pool by assigning assets and weights, create the LP tokens
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
   * Compute the liquidity for the given sender based on the state
   * in the contract
   * @param sender - the sender
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
   * Swap the token from for the token to
   * @param {Address} sender
   * @param {uint64} from
   * @param {uint64} to
   * @param {uint64} amount
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

  /** ******************* */
  /**     SUBROUTINES     */
  /** ******************* */

  /**
   * Add a token by setting balances and weights associated
   * in their box
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
   * Create the LP tokens for this pool
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

  private exp(x: uint64): uint64 {
    let result = SCALE;
    let term = SCALE;

    for (let i = 1; i <= 10; i = i + 1) {
      term = wideRatio([term, x], [i * SCALE]);
      result += term;
    }

    return result;
  }

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
    }

    const totalLP = this.totalLP();
    return wideRatio([totalLP, ratio], [SCALE]);
  }

  private totalLP(): uint64 {
    return this.token.value.total - this.token.value.reserve.assetBalance(this.token.value) - this.burned.value;
  }

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
}
