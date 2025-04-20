/* eslint-disable no-await-in-loop, no-restricted-syntax, import/no-extraneous-dependencies */
import algosdk, { Algodv2 } from 'algosdk';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';

dotenv.config();

export const getAlgodAndDeployer = () => {
  const algod = new algosdk.Algodv2(process.env.ALGOD_TOKEN!, process.env.ALGOD_SERVER!, process.env.ALGOD_PORT!);
  const mnemonic = process.env.ACCOUNT_MNEMONIC!;

  const DEPLOYER = algosdk.mnemonicToSecretKey(mnemonic);

  return { algod, DEPLOYER };
};

export const compileContract = async (algod: Algodv2, contract: string) => {
  const approvalTeal = fs.readFileSync(
    path.resolve(__dirname, `../contracts/artifacts/${contract}.approval.teal`),
    'utf8'
  );
  const clearTeal = fs.readFileSync(path.resolve(__dirname, `../contracts/artifacts/${contract}.clear.teal`), 'utf8');

  const approvalCompiled = await algod.compile(approvalTeal).do();
  const clearCompiled = await algod.compile(clearTeal).do();

  const approvalProgram = new Uint8Array(Buffer.from(approvalCompiled.result, 'base64'));
  const clearProgram = new Uint8Array(Buffer.from(clearCompiled.result, 'base64'));

  console.log(approvalProgram.buffer);

  fs.writeFileSync(path.resolve(__dirname, `../contracts/artifacts/${contract}.approval.txt`), approvalCompiled.result);

  console.log(`✅ [${contract}] Contract compiled and saved successfully!`);
  return { approvalProgram, clearProgram };
};

export type Contract = {
  name: string;
  params: {
    onComplete: algosdk.OnApplicationComplete;
    numGlobalInts: number;
    numGlobalByteSlices: number;
    numLocalInts?: number;
    numLocalByteSlices?: number;
    extraPages?: number;
  };
};
