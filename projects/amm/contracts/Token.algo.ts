import { Contract } from '@algorandfoundation/tealscript';

const TOTAL_SUPPLY = 10 ** 16;

export class Token extends Contract {
  total_supply = GlobalStateKey<uint64>({ key: 'total_supply' });

  token = GlobalStateKey<AssetID>({ key: 'token' });

  balances = BoxMap<Address, uint64>({});

  @allow.bareCreate('NoOp')
  createApplication() {
    this.token.value = AssetID.zeroIndex;
    this.total_supply.value = 0;
  }

  bootstrap(name: bytes, unit: bytes, seed: PayTxn): AssetID {
    assert(this.token.value === AssetID.zeroIndex, 'application has already been bootstrapped');
    assert(seed.amount >= 300_000, 'amount minimum not met');
    assert(seed.receiver === this.app.address, 'receiver not app address');

    this.createToken(name, unit);

    sendAssetTransfer({
      xferAsset: this.token.value,
      assetAmount: 0,
      assetReceiver: this.app.address,
      fee: 1000,
    });

    return this.token.value;
  }

  mint(amount: uint64) {
    this.total_supply.value += amount;

    const sender = this.txn.sender;

    if (!this.balances(sender).exists) {
      this.balances(sender).value = 0;
    }

    this.balances(sender).value += amount;

    sendAssetTransfer({
      assetReceiver: this.txn.sender,
      assetAmount: amount,
      xferAsset: this.token.value,
      sender: this.app.address,
    });
  }

  private createToken(name: bytes, unit: bytes) {
    this.token.value = sendAssetCreation({
      configAssetTotal: TOTAL_SUPPLY,
      configAssetDecimals: 6,
      configAssetReserve: this.app.address,
      configAssetManager: this.app.address,
      configAssetClawback: globals.zeroAddress,
      configAssetFreeze: globals.zeroAddress,
      configAssetDefaultFrozen: 0,
      configAssetName: name,
      configAssetUnitName: unit,
    });
  }
}
