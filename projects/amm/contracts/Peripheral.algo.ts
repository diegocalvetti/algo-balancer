import { Contract } from '@algorandfoundation/tealscript';
import { AssetVault } from './AssetVault.algo';

export class Peripheral extends Contract {
  execute(pool: AppID, values: uint64[], assets: AssetID[], rekey: PayTxn) {
    verifyPayTxn(rekey, {
      receiver: this.txn.sender,
      rekeyTo: this.app.address,
      amount: 0,
    });

    assert(values.length === assets.length, 'Values and assets length mismatch');

    // @todo maybe check that values respect the pool weights

    for (let i = 0; i < assets.length; i += 1) {
      sendMethodCall<typeof AssetVault.prototype.addLiquidity>({
        applicationID: pool,
        methodArgs: [
          i,
          {
            assetReceiver: pool.address,
            assetAmount: values[i],
            xferAsset: assets[i],
          },
        ], //@todo re-code the AddLiquidity -> Need to account for all the txn being done (possibly 100s of them) [128 is the limit] AND verify them
      });
    }

    sendPayment({
      receiver: this.app.address,
      amount: 0,
      rekeyTo: this.txn.sender,
      closeRemainderTo: this.txn.sender,
    });
  }
}
