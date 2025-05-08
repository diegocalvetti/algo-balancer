import { Contract } from '@algorandfoundation/tealscript';

const TOTAL_LP_SUPPLY = 10 ** 16;
const AMOUNT_LP_DEPLOYER = 1_000_000 * 10 ** 6;
const SCALE = 1_000_000;

type SignedUint64 = { negative: boolean; value: uint64 };

export class BalancedPoolV2 extends Contract {
  manager = GlobalStateKey<Address>({ key: 'manager' });

  token = GlobalStateKey<AssetID>({ key: 'token' });

  assets = GlobalStateKey<AssetID[]>({ key: 'assets' });

  weights = BoxMap<uint64, uint64>({ prefix: 'weights_' });

  balances = BoxMap<AssetID, uint64>({ prefix: 'balances_' });

  provided = BoxMap<Address, uint64[]>({ prefix: 'provided_', dynamicSize: true });

  minRatios = BoxMap<Address, uint64>({ prefix: 'minratio_' });

  /**
   * createApplication method called at creation
   */
  @allow.bareCreate('NoOp')
  createApplication() {
    this.manager.value = this.app.creator;
  }

  /**
   * Bootstrap the pool by assigning assets and weights, create the LP tokens
   * @param {AssetID[]} assetIds - assets of the pool
   * @param {uint64[]} weights - weights of the pool
   * @return uint64 - LP Token created ID
   */
  bootstrap(assetIds: AssetID[], weights: uint64[]): AssetID {
    this.assertIsManager();
    let total = 0;

    for (let i = 0; i < assetIds.length; i += 1) {
      this.addToken(i, assetIds[i], weights[i]);
      total += weights[i];
    }

    this.assets.value = assetIds;

    assert(total === SCALE, 'Weights must sum to 1');
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
    assert(this.token.value !== AssetID.zeroIndex, 'pool not bootstrapped');
    const assetId = this.assets.value[index];
    log('Asset ID => ' + itob(assetId));

    this.optIn(assetId);
    this.balances(assetId).value += amount;

    if (!this.provided(sender).exists) {
      this.provided(sender).create(64);
    }

    this.provided(sender).value[index] += amount;

    const newMinRatio = this.computeLP(sender, index);

    if (!this.minRatios(sender).exists) {
      this.minRatios(sender).create(8);
      this.minRatios(sender).value = newMinRatio;
      // eslint-disable-next-line eqeqeq
    } else if (this.minRatios(sender).value == 0) {
      this.minRatios(sender).value = newMinRatio;
    } else {
      const currentMin = this.minRatios(sender).value;

      if (newMinRatio < currentMin) {
        this.minRatios(sender).value = newMinRatio;
      }
    }
  }

  /**
   * Compute the liquidity for the given sender based on the state
   * in the contract
   * @param sender - the sender
   */
  computeLiquidity(sender: Address) {
    this.assertIsManager();
    const minRatio = this.minRatios(sender).value;

    assert(minRatio > 0, 'computed ratio is zero');

    let amount = AMOUNT_LP_DEPLOYER;
    if (this.token.value.reserve.assetBalance(this.token.value) !== TOTAL_LP_SUPPLY) {
      const issued = this.token.value.total - this.token.value.reserve.assetBalance(this.token.value);
      amount = wideRatio([issued, minRatio], [SCALE]);
    }

    assert(amount > 0, 'computed LP amount is zero');

    this.minRatios(sender).value = 0;

    for (let i = 0; i < this.provided(sender).value.length; i += 1) {
      this.provided(sender).value[i] = 0;
    }

    sendAssetTransfer({
      assetReceiver: sender,
      assetAmount: amount,
      xferAsset: this.token.value,
    });
  }

  swap(sender: Address, from: uint64, to: uint64, amount: uint64) {
    assert(this.token.value !== AssetID.zeroIndex, 'pool not bootstrapped');

    const assetIn = this.assets.value[from];
    const assetOut = this.assets.value[to];

    const balanceIn = this.balances(assetIn).value;
    const balanceOut = this.balances(assetOut).value;

    const weightIn = this.weights(from).value;
    const weightOut = this.weights(to).value;

    log(itob(balanceIn));
    log(itob(balanceOut));
    log(itob(weightIn));
    log(itob(weightOut));

    const amountOut = this.calcOut(balanceIn, weightIn, balanceOut, weightOut, amount);

    log(itob(amountOut));

    this.balances(assetIn).value = balanceIn + amount;
    this.balances(assetOut).value = balanceOut - amountOut;

    sendAssetTransfer({
      assetReceiver: sender,
      assetAmount: amountOut,
      xferAsset: assetOut,
    });
  }

  /**
   * @param assetId asset to opt-in
   * @todo why?
   */
  optIn(assetId: AssetID): void {
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
   * Add a token setting balances and weights associated
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

    for (let i = 2; i <= 5; i = i + 1) {
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

  /**
   * Compute the ratio of the given token respect to the total balance of the pool
   */
  private computeLP(sender: Address, index: uint64): uint64 {
    const assetId = this.assets.value[index];
    const weight = this.weights(index).value;
    const poolBalance = this.balances(assetId).value;
    const providedAmount = this.provided(sender).value[index];

    if (providedAmount <= 0) {
      return 0;
    }

    const ratio = wideRatio([providedAmount, SCALE], [poolBalance]);
    return wideRatio([ratio, weight], [SCALE]);
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

    log(itob(ratio));
    log(itob(power));

    // output = balanceOut * (1 - ratio^power)
    const ratioPow = this.pow(ratio, power);

    return wideRatio([balanceOut, SCALE - ratioPow], [SCALE]);
  }
}
