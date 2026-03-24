import { Contract } from '@algorandfoundation/tealscript';
import { AssetVault } from './AssetVault.algo';
import { DexPool } from './DexPool.algo';

type Pool = {
  type: uint64;
  id: AppID;
  assets: AssetID[];
  weights: uint64[];
};

const VAULT_POOL_TYPE = 0;
const DEX_POOL_TYPE = 1;

// @todo move to globals
const MBR_CONTRACT_PROGRAM = 100_000;
const MBR_CREATE_POOL = 100_000;
const MBR_CREATE_VAULT = 100_000;
const MBR_INIT_POOL = 1_000_000;

export class Factory extends Contract {
  manager = GlobalStateKey<Address>({ key: 'manager' });

  // @todo why not use BoxKey?

  dexPoolContractApprovalProgram = BoxMap<uint64, bytes>({
    prefix: 'pool_approval_program_page_',
    dynamicSize: true,
  });

  vaultPoolContractApprovalProgram = BoxMap<uint64, bytes>({
    prefix: 'vault_pool_approval_program_page_',
    dynamicSize: true,
  });

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
   * must be loaded in dexPoolContractApprovalProgram
   */
  createPool(payMBR: PayTxn, type: uint64): void {
    // @todo check MBR cost
    verifyPayTxn(payMBR, {
      receiver: this.app.address,
      amount: MBR_CREATE_POOL,
    });

    if (type === DEX_POOL_TYPE) {
      for (let i = 0; i < 8; i += 1) {
        if (!this.dexPoolContractApprovalProgram(i).exists) {
          this.dexPoolContractApprovalProgram(i).value = '';
        }
      }

      sendAppCall({
        onCompletion: OnCompletion.NoOp,
        approvalProgram: [
          this.dexPoolContractApprovalProgram(0).value,
          this.dexPoolContractApprovalProgram(1).value,
          this.dexPoolContractApprovalProgram(2).value,
          this.dexPoolContractApprovalProgram(3).value,
          this.dexPoolContractApprovalProgram(4).value,
          this.dexPoolContractApprovalProgram(5).value,
          this.dexPoolContractApprovalProgram(6).value,
          this.dexPoolContractApprovalProgram(7).value,
        ],
        clearStateProgram: DexPool.clearProgram(),
        globalNumUint: DexPool.schema.global.numUint,
        globalNumByteSlice: DexPool.schema.global.numByteSlice,
        extraProgramPages: 3,
        applicationArgs: [method('createApplication()void')],
        fee: payMBR.amount,
      });
    } else {
      for (let i = 0; i < 8; i += 1) {
        if (!this.vaultPoolContractApprovalProgram(i).exists) {
          this.vaultPoolContractApprovalProgram(i).value = '';
        }
      }

      sendAppCall({
        onCompletion: OnCompletion.NoOp,
        approvalProgram: [
          this.vaultPoolContractApprovalProgram(0).value,
          this.vaultPoolContractApprovalProgram(1).value,
          this.vaultPoolContractApprovalProgram(2).value,
          this.vaultPoolContractApprovalProgram(3).value,
          this.vaultPoolContractApprovalProgram(4).value,
          this.vaultPoolContractApprovalProgram(5).value,
          this.vaultPoolContractApprovalProgram(6).value,
          this.vaultPoolContractApprovalProgram(7).value,
        ],
        clearStateProgram: AssetVault.clearProgram(),
        globalNumUint: AssetVault.schema.global.numUint,
        globalNumByteSlice: AssetVault.schema.global.numByteSlice,
        extraProgramPages: 3,
        applicationArgs: [method('createApplication()void')],
        fee: payMBR.amount,
      });
    }
  }

  createVault(payMBR: PayTxn): void {
    // @todo check MBR cost
    verifyPayTxn(payMBR, {
      receiver: this.app.address,
      amount: MBR_CREATE_VAULT,
    });
    for (let i = 0; i < 8; i += 1) {
      if (!this.vaultPoolContractApprovalProgram(i).exists) {
        this.vaultPoolContractApprovalProgram(i).value = '';
      }
    }

    sendAppCall({
      onCompletion: OnCompletion.NoOp,
      approvalProgram: [
        this.vaultPoolContractApprovalProgram(0).value,
        this.vaultPoolContractApprovalProgram(1).value,
        this.vaultPoolContractApprovalProgram(2).value,
        this.vaultPoolContractApprovalProgram(3).value,
        this.vaultPoolContractApprovalProgram(4).value,
        this.vaultPoolContractApprovalProgram(5).value,
        this.vaultPoolContractApprovalProgram(6).value,
        this.vaultPoolContractApprovalProgram(7).value,
      ],
      clearStateProgram: AssetVault.clearProgram(),
      globalNumUint: AssetVault.schema.global.numUint,
      globalNumByteSlice: AssetVault.schema.global.numByteSlice,
      extraProgramPages: 3,
      applicationArgs: [method('createApplication()void')],
      fee: payMBR.amount,
    });
  }

  /**
   * Initialize the pool with the given assets & weights
   * @param {AppID} poolID - Pool App ID
   * @param type
   * @param {AssetID[]} assetIds
   * @param {uint64[]} weights
   * @param coverMBR
   */
  initPool(poolID: AppID, type: uint64, assetIds: AssetID[], weights: uint64[], coverMBR: PayTxn): AssetID {
    verifyPayTxn(coverMBR, {
      receiver: poolID.address,
      amount: MBR_INIT_POOL, // @todo globals.assetOptInMinBalance * assetIds.length + globals.assetCreateMinBalance,
    });
    assert(assetIds.length >= 2, 'At least 2 tokens needed');
    assert(assetIds.length <= 128, 'Maximum of 128 assets per pool');
    assert(assetIds.length === weights.length, 'Weights and Assets length must be the same');
    assert(this.listIsOrdered(assetIds), 'Assets must be ordered by ID');

    if (type === DEX_POOL_TYPE) {
      const hash = this.getPoolHash(assetIds, weights);
      assert(!this.pools(hash).exists, 'This pool already exists');
      this.pools(hash).value = { id: poolID, type: type, assets: assetIds, weights: weights };
    }

    let LPTokenID: AssetID = AssetID.zeroIndex;

    if (type === DEX_POOL_TYPE) {
      LPTokenID = sendMethodCall<typeof DexPool.prototype.bootstrap, AssetID>({
        applicationID: poolID,
        methodArgs: [assetIds, weights, 20, 5],
      });
    } else if (type === VAULT_POOL_TYPE) {
      LPTokenID = sendMethodCall<typeof AssetVault.prototype.bootstrap, AssetID>({
        applicationID: poolID,
        methodArgs: [assetIds, weights],
      });
    }

    return LPTokenID;
  }

  opUp(): void {}

  /** ******************* */
  /**       MANAGER       */
  /** ******************* */

  // @todo check MBR cost of program and make an init method to cover for it

  MANAGER_writePoolContractProgram(offset: uint64, data: bytes, type: uint64): void {
    this.assertIsManager();
    const pageIndex = (offset + 4096 - 1) / 4096;

    if (type === DEX_POOL_TYPE) {
      this.dexPoolContractApprovalProgram(pageIndex).value = data;
    } else if (type === VAULT_POOL_TYPE) {
      this.vaultPoolContractApprovalProgram(pageIndex).value = data;
    }
  }

  /** ******************* */
  /**     SUBROUTINES     */
  /** ******************* */

  private assertIsManager(): void {
    assert(this.txn.sender === this.manager.value, 'only the manager can call this method');
  }

  private listIsOrdered(assetIds: AssetID[]): boolean {
    for (let i = 1; i < assetIds.length; i += 1) {
      if (assetIds[i] < assetIds[i - 1]) {
        return false;
      }
    }
    return true;
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
