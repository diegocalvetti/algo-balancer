import { Contract } from '@algorandfoundation/tealscript';
import { BalancedPoolV2 } from './BalancedPoolV2.algo';

export class Factory extends Contract {
  manager = GlobalStateKey<Address>({ key: 'manager' });

  poolContractApprovalProgram = BoxKey<bytes>({ key: 'pool_approval_program' });

  @allow.bareCreate('NoOp')
  createApplication() {
    this.manager.value = this.app.creator;
  }

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

  getProgram(): bytes {
    return this.poolContractApprovalProgram.value;
  }

  MANAGER_updatePoolContractProgram(programSize: uint64): void {
    assert(this.txn.sender === this.manager.value, 'only the manager can call this method');

    if (this.poolContractApprovalProgram.exists) {
      this.poolContractApprovalProgram.resize(programSize);
    } else {
      this.poolContractApprovalProgram.create(programSize);
    }
  }

  MANAGER_writePoolContractProgram(offset: uint64, data: bytes): void {
    assert(this.txn.sender === this.manager.value, 'only the manager can call this method');
    this.poolContractApprovalProgram.replace(offset, data);
  }

  hasPoolApprovalProgram(): boolean {
    return this.poolContractApprovalProgram.exists;
  }
}
