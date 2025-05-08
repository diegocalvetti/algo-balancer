import { Contract } from '@algorandfoundation/tealscript';
import { BalancedPoolV2 } from './BalancedPoolV2.algo';

export class Factory extends Contract {
  manager = GlobalStateKey<Address>({ key: 'manager' });

  poolContractApprovalProgram = BoxKey<bytes>({ key: 'pool_approval_program' });

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
      clearStateProgram: BalancedPoolV2.clearProgram(),
      globalNumUint: BalancedPoolV2.schema.global.numUint,
      globalNumByteSlice: BalancedPoolV2.schema.global.numByteSlice,
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
    return sendMethodCall<typeof BalancedPoolV2.prototype.bootstrap, AssetID>({
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
    sendMethodCall<typeof BalancedPoolV2.prototype.addLiquidity>({
      applicationID: poolID,
      methodArgs: [index, transferTxn.assetAmount, transferTxn.sender],
    });
  }

  /**
   * Compute the liquidity for the sender and send the expected LP
   * @param {AppID} poolID - Pool App ID
   */
  computeLiquidity(poolID: AppID) {
    sendMethodCall<typeof BalancedPoolV2.prototype.computeLiquidity>({
      applicationID: poolID,
      methodArgs: [this.txn.sender],
    });
  }

  swap(poolID: AppID, from: uint64, to: uint64, transferTxn: AssetTransferTxn) {
    sendMethodCall<typeof BalancedPoolV2.prototype.swap>({
      applicationID: poolID,
      methodArgs: [this.txn.sender, from, to, transferTxn.assetAmount],
    });
  }

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

  private assertIsManager() {
    assert(this.txn.sender === this.manager.value, 'only the manager can call this method');
  }
}
