import algosdk, {ABIContract, type ABIContractParams, Address, AtomicTransactionComposer, Indexer, type TransactionSigner} from "algosdk";

import {type WalletAccount, WalletId} from "@txnlab/use-wallet";
import {AlgodClient} from "algosdk/client/algod";
import {walletManager} from "$lib/wallet";
import type {BoxReference} from "@algorandfoundation/algokit-utils/types/app-manager";
import {prepareGroupForSending} from "@algorandfoundation/algokit-utils";

type TransactionParams = {
  methodArgs?: any[];
  fee?: number;
  flatFee?: boolean;
  numGlobalInts?: number;
  numGlobalByteSlices?: number;
  numLocalInts?: number;
  numLocalByteSlices?: number;
  extraPages?: number;
  appAccounts?: Array<string | Address>;
  appForeignApps?: Array<number | bigint>;
  appForeignAssets?: Array<number | bigint>;
  boxes?: any[];
  note?: Uint8Array;
  lease?: Uint8Array;
  rekeyTo?: string | Address;
}

export class Contract {

    public appId : number
    public appAddress : Address

    private sender : WalletAccount|null = null
    private signer : TransactionSigner|null = null
    private suggestedParams : any = null
    atc : AtomicTransactionComposer|null = null

    public readonly algod : AlgodClient
    private readonly contract : ABIContract
    private readonly indexer : Indexer

    constructor(algod : AlgodClient, indexer : Indexer, appId : number, abi : ABIContractParams) {
        this.appId = appId
        this.appAddress = algosdk.getApplicationAddress(appId)
        this.contract = new algosdk.ABIContract(abi)

        this.algod = algod
        this.indexer = indexer
    }

    public async tx() {
        this.sender = walletManager.getWallet(WalletId.LUTE)?.activeAccount!
        this.signer = walletManager.getWallet(WalletId.LUTE)?.transactionSigner!
        this.suggestedParams = await this.algod.getTransactionParams().do()
        this.atc = new algosdk.AtomicTransactionComposer()

        return {
            suggestedParams: this.suggestedParams,
            atc: this.atc,
            sender: this.sender.address.toString(),
            signer: this.signer,
            appId: this.appId,
            appAddress: this.appAddress
        }
    }

    addCall(method : string, params : TransactionParams) {
        if (!this.sender) throw Error("Wallet not connected")
        if (!this.signer) throw Error("Signer not found")
        if (!this.atc) throw Error("Tx not created")

        this.suggestedParams.flatFee = params.flatFee ?? true;
        this.suggestedParams.fee = params.fee ?? 300_000;

        delete params.fee
        delete params.flatFee

        console.log(walletManager.getWallet(WalletId.LUTE)?.activeAddress!);
        console.log(JSON.stringify(this.atc, null, 2));
        // @ts-ignore
        this.atc.addMethodCall({
            appID: this.appId,
            method: this.contract.getMethodByName(method),
            suggestedParams: this.suggestedParams,
            sender: walletManager.getWallet(WalletId.LUTE)?.activeAddress!,
            signer: this.signer,
            ...params,
        })

      console.log(JSON.stringify(this.atc, null, 2));

      //this.atc = await prepareGroupForSending(this.atc!, this.algod, {populateAppCallResources: true})

        return this;
    }

    async prepare() {
      this.atc = await prepareGroupForSending(this.atc!, this.algod, {populateAppCallResources: true})
    }

    async execute() {
        if (!this.atc) throw Error("Tx not created")

        console.log("###### Sending TX ######")

        try {
            const res = await this.atc.execute(this.algod, 1)
            console.log('Success', res)
            this.log(
                res.methodResults[0].txInfo?.logs
            )

            return res;
        } catch (e) {
            console.error('TX fallita:', e)
            const debug = await this.atc.simulate(this.algod)
            console.log('🔍 Simulazione:', JSON.stringify(debug, (_, value) =>
                typeof value === 'bigint' ? value.toString() : value
            ))

            this.log(
                debug.methodResults[0].txInfo?.logs
            )
        }
    }

    async getTransactionHistory() {
        return await this.indexer.searchForTransactions()
            .txType("appl")
            .applicationID(this.appId)
            .limit(1000)
            .do();
    }

    public decodeLogs(logs : Uint8Array<ArrayBufferLike>[]|undefined) : any[] {
        if(!logs) return []

        let next = "string"

        return logs.map(log =>  {
            let text = new TextDecoder("utf-8").decode(log)

            if (text.includes("#UInt64")) {
                next = "uint64"

                return text
            }

            let result

            switch (next) {
                case "uint64":
                    const dw = new DataView(log.buffer, log.byteOffset, 8)
                    result = dw.getBigUint64(0, false);
                    break;
                case "string":
                default:
                    result = text
            }

            next = "string"
            return result
        })
    }

    private log(logs : Uint8Array<ArrayBufferLike>[]|undefined) {
        console.log("###### LOGS ######", logs)
        const logsDecoded = this.decodeLogs(logs)

        if (logsDecoded.length > 0) {
            logsDecoded.forEach(log => {
                console.log(log)
            })
        } else {
            console.log("No logs from the contract")
        }


    }

    private keyAsString(keyBytes : any) {
        return new TextDecoder().decode(keyBytes);
    }
    async getGlobalState() : Promise<any> {
        const appInfo = await this.algod.getApplicationByID(this.appId).do();
        const globalState = appInfo.params['globalState'];

        if (!globalState) return {}

        const state = {}

        globalState.forEach((kv) => {
            const key = this.keyAsString(kv.key);
            const value = kv.value;

            if (value.type === 2) {
                // @ts-ignore
                state[key] = value.uint;
            } else if (value.type === 1) {
                // @ts-ignore
                state[key] = new TextDecoder().decode(value.bytes); // optional
            }
        });

        return state
    }
    async getFromGlobalState(key : string) {
        const state = await this.getGlobalState()
        return state[key]
    }

}
