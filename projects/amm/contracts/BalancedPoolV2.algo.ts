import { Contract } from '@algorandfoundation/tealscript';

const SCALE = 1_000_000;

export class BalancedPoolV2 extends Contract {
  manager = GlobalStateKey<Address>({ key: 'manager' });

  weights = BoxMap<uint64, uint64>({ prefix: 'weights_' });

  balances = BoxMap<AssetID, uint64>({ prefix: 'balances_' });

  provided = BoxMap<Address, uint64[]>({ prefix: 'provided_' });

  token = GlobalStateKey<AssetID>({ key: 'token' });

  assets = GlobalStateKey<AssetID[]>({ key: 'assets' });

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
   * Provide Liquidity to the pool proportionally to the weights
   */
  addLiquidity(index: uint64, amount: uint64, sender: Address) {
    assert(this.token.value !== AssetID.zeroIndex, 'pool not bootstrapped');
    const assetId = this.assets.value[index];
    log('Asset ID => ' + itob(assetId));

    /*
    this.optIn(assetId);

    this.balances(assetId).value += amount;

    if (!this.provided(sender).exists) {
      this.provided(sender).create(64);
    }

    this.provided(this.txn.sender).value[index] = amount;
    */

    /*
    let totalLiquidity = 0;

    // Tutte le tx prima di questa
    for (let i = 0; i < this.txnGroup.length - 1; i += 1) {
      verifyAssetTransferTxn(this.txnGroup[i], {
        xferAsset: this.assets(i).value,
        assetReceiver: this.app.address,
      });
    }

    for (let i = 1; i < this.txnGroup.length; i += 1) {
      const assetId = this.txnGroup[i].xferAsset;
      const amount = this.txnGroup[i].assetAmount;

      const weight = this.weights(i).value;
      this.balances(assetId).value += amount;

      totalLiquidity += (amount * SCALE) / weight;
    }

    sendAssetTransfer({
      xferAsset: this.token.value,
      assetAmount: totalLiquidity,
      assetReceiver: this.txn.sender,
      assetSender: this.app.address,
    });

    return totalLiquidity; */
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
    assert(this.txn.sender === this.manager.value, 'only the manager can call this method');

    if (this.token.value === AssetID.zeroIndex) {
      this.token.value = sendAssetCreation({
        configAssetTotal: 10 ** 16,
        configAssetDecimals: 6,
        configAssetReserve: this.app.address,
        configAssetManager: this.app.address,
        configAssetClawback: globals.zeroAddress,
        configAssetFreeze: globals.zeroAddress,
        configAssetDefaultFrozen: 0,
        configAssetName: 'BalancedPool-' + itob(this.app.id),
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
