import { Contract } from '@algorandfoundation/tealscript';

const TOTAL_LP_SUPPLY = 10 ** 16;
const AMOUNT_LP_DEPLOYER = 1_000_000 * 10 ** 6;
const SCALE = 1_000_000;

export class BalancedPoolV2 extends Contract {
  manager = GlobalStateKey<Address>({ key: 'manager' });

  token = GlobalStateKey<AssetID>({ key: 'token' });

  assets = GlobalStateKey<AssetID[]>({ key: 'assets' });

  weights = BoxMap<uint64, uint64>({ prefix: 'weights_' });

  balances = BoxMap<AssetID, uint64>({ prefix: 'balances_' });

  provided = BoxMap<Address, uint64[]>({ prefix: 'provided_', dynamicSize: true });

  minRatios = BoxMap<Address, uint64>({ prefix: 'minratio_' });

  @allow.bareCreate('NoOp')
  createApplication() {
    this.manager.value = this.app.creator;
  }

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
   * Provide Liquidity to the pool
   */
  addLiquidity(index: uint64, amount: uint64, sender: Address) {
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

  computeLiquidity(sender: Address) {
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

  private createToken() {
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

  private assertIsManager() {
    assert(this.txn.sender === this.manager.value, 'only the manager can call this method');
  }

  /**
   * Approximate ln(x) using the Mercator series expansion
   */
  private ln(x: uint64): uint64 {
    assert(x > 0, 'log undefined for x ≤ 0');

    // (x - 1) / x  →  (x - SCALE) * SCALE / x
    const z = ((x - SCALE) * SCALE) / x;
    let result = z;
    let term = z;
    let neg = false;

    for (let i = 2; i <= 10; i = i + 1) {
      term = (term * z) / SCALE;
      const delta = term / i;
      result = neg ? result - delta : result + delta;
      neg = !neg;
    }

    return result;
  }

  /**
   * Approximate e^x using the Taylor series expansion
   */
  private exp(x: uint64): uint64 {
    let result = SCALE;
    let term = SCALE;

    for (let i = 1; i <= 10; i = i + 1) {
      term = (term * x) / (i * SCALE);
      result += term;
    }

    return result;
  }

  /**
   * Approximate x^y by computing e^(y ln x)
   */
  private pow(x: uint64, y: uint64): uint64 {
    const lnX = this.ln(x);
    const ylnX = (y * lnX) / SCALE; // y * ln(x)
    return this.exp(ylnX); // e^(y ln x) = x^y
  }

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

    const amountInWithFee = (amountIn * (SCALE - fee)) / SCALE;

    // x / (x + Dx - f)
    const ratio = balanceIn / (balanceIn + amountInWithFee);

    const power = (weightIn * SCALE) / weightOut;

    // output = balanceOut * (1 - ratio^power)
    const ratioPow = this.pow(ratio, power);

    return (balanceOut * (SCALE - ratioPow)) / SCALE;
  }
}
