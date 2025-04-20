import { Contract } from '@algorandfoundation/tealscript';

const SCALE = 1_000_000;

export class BalancedPoolV2 extends Contract {
  manager = GlobalStateKey<Address>({ key: 'manager' });

  assets = BoxMap<uint64, AssetID>({ prefix: 'assets_' });

  weights = BoxMap<uint64, uint64>({ prefix: 'weights_' });

  balances = BoxMap<AssetID, uint64>({ prefix: 'balances_' });

  totalAssets = GlobalStateKey<uint64>({ key: 'totalAssets' });

  token = GlobalStateKey<AssetID>({ key: 'token' });

  @allow.bareCreate('NoOp')
  createApplication() {
    this.manager.value = this.app.creator;
  }

  addToken(index: uint64, assetID: AssetID, weight: uint64) {
    this.assets(index + 1).value = assetID;
    this.weights(index + 1).value = weight;
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
