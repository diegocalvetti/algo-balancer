import { Contract } from '@algorandfoundation/tealscript';
import { AssetVault } from './AssetVault.algo';

type Pool = {
  id: AppID;
  assets: AssetID[];
  weights: uint64[];
};

export class Factory extends Contract {
  manager = GlobalStateKey<Address>({ key: 'manager' });

  poolContractApprovalProgram = BoxKey<bytes>({ key: 'pool_approval_program' });

  pools = BoxMap<bytes32, Pool>({ prefix: 'pools_' });

  /**
   * createApplication method called at creation
   */
  @allow.bareCreate('NoOp')
  createApplication() {
    this.manager.value = this.app.creator;
  }

  /**
   * Deploy the pool contract, compiled teal of the contract
   * must be loaded in poolContractApprovalProgram
   */
  createPool() {
    sendAppCall({
      onCompletion: OnCompletion.NoOp,
      approvalProgram: this.poolContractApprovalProgram.value,
      clearStateProgram: AssetVault.clearProgram(),
      globalNumUint: AssetVault.schema.global.numUint,
      globalNumByteSlice: AssetVault.schema.global.numByteSlice,
      extraProgramPages: 3,
      applicationArgs: [method('createApplication()void')],
      fee: 100_000,
    });
  }

  /**
   * Initialize the pool with the given assets & weights
   * @param {AppID} poolID - Pool App ID
   * @param {AssetID[]} assetIds
   * @param {uint64[]} weights
   */
  initPool(poolID: AppID, assetIds: AssetID[], weights: uint64[]): AssetID {
    // @todo check assetIds in in-order
    assert(assetIds.length >= 2, 'At least 2 tokens needed');
    assert(assetIds.length === weights.length, 'Weights and Assets length must be the same');

    const hash = this.getPoolHash(assetIds, weights);

    assert(!this.pools(hash).exists, 'This pool already exists');

    this.pools(hash).value = { id: poolID, assets: assetIds, weights: weights };

    return sendMethodCall<typeof AssetVault.prototype.bootstrap, AssetID>({
      applicationID: poolID,
      methodArgs: [assetIds, weights],
    });
  }

  /**
   * Add one token as liquidity to the pool
   * @param {AppID} poolID - Pool App ID
   * @param {uint64} index - the index
   * @param {AssetTransferTxn} transferTxn - transfer tx of the token, receiver must be the pool account
   */
  addLiquidity(poolID: AppID, index: uint64, transferTxn: AssetTransferTxn) {
    sendMethodCall<typeof AssetVault.prototype.addLiquidity>({
      applicationID: poolID,
      methodArgs: [index, transferTxn.assetAmount, transferTxn.sender],
    });
  }

  /**
   * Compute the liquidity for the sender and send the LPs expected
   * @param {AppID} poolID - Pool App ID
   * @return uint64 - The LPs expected
   */
  getLiquidity(poolID: AppID): uint64 {
    return sendMethodCall<typeof AssetVault.prototype.getLiquidity>({
      applicationID: poolID,
      methodArgs: [this.txn.sender],
    });
  }

  burnLiquidity(poolID: AppID, transferTxn: AssetTransferTxn) {
    sendMethodCall<typeof AssetVault.prototype.burnLiquidity>({
      applicationID: poolID,
      methodArgs: [this.txn.sender, transferTxn.assetAmount],
    });
  }

  swap(poolID: AppID, from: uint64, to: uint64, transferTxn: AssetTransferTxn): uint64 {
    return sendMethodCall<typeof AssetVault.prototype.swap>({
      applicationID: poolID,
      methodArgs: [this.txn.sender, from, to, transferTxn.assetAmount],
    });
  }

  changeWeights(poolID: AppID, newWeights: uint64[], duration: uint64): uint64 {
    return sendMethodCall<typeof AssetVault.prototype.changeWeights>({
      applicationID: poolID,
      methodArgs: [duration, newWeights],
    });
  }

  addAsset(poolID: AppID, asset: AssetID, w: uint64): uint64 {
    return sendMethodCall<typeof AssetVault.prototype.addAsset>({
      applicationID: poolID,
      methodArgs: [asset, w],
    });
  }

  opUp(): void {}

  /** ******************* */
  /**       MANAGER       */
  /** ******************* */

  MANAGER_updatePoolContractProgram(programSize: uint64): void {
    this.assertIsManager();

    if (this.poolContractApprovalProgram.exists) {
      this.poolContractApprovalProgram.resize(programSize);
    } else {
      this.poolContractApprovalProgram.create(programSize);
    }
  }

  MANAGER_writePoolContractProgram(offset: uint64, data: bytes): void {
    this.assertIsManager();

    this.poolContractApprovalProgram.replace(offset, data);
  }

  /** ******************* */
  /**     SUBROUTINES     */
  /** ******************* */

  private assertIsManager(): void {
    assert(this.txn.sender === this.manager.value, 'only the manager can call this method');
  }

  private getPoolHash(assetIds: AssetID[], weights: uint64[]): bytes32 {
    let parts: bytes = '';

    for (let i = 0; i < assetIds.length; i += 1) {
      parts += itob(assetIds[i]);
      parts += itob(weights[i]);
    }

    return sha512_256(parts);
  }

  @abi.readonly
  getPool(assetIds: AssetID[], weights: uint64[]): Pool {
    const hash = this.getPoolHash(assetIds, weights);
    return this.pools(hash).value;
  }
}
