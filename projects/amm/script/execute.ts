/* eslint-disable no-console, no-case-declarations, import/no-extraneous-dependencies, no-await-in-loop, no-restricted-syntax */
import inquirer from 'inquirer';
import path from 'node:path';
import fs from 'node:fs';
import { deploy, deployToken, factorySetup, mintToken, poolSetup, tokenSetup } from '../utils/bootstrap';
import { addLiquidity } from '../utils/amm';

export type BootstrapResult = { FACTORY_ID: bigint; POOL_ID: bigint; TOKENS: bigint[]; TOKENS_APP: bigint[] };
type Commands =
  | 'Create some Tokens'
  | 'Mint some Tokens'
  | 'Deploy & Bootstrap Factory'
  | 'Write & Deploy Pool'
  | 'Add Liquidity'
  | 'Quit';

function title(text: string): void {
  console.log(`************* ${text.toUpperCase()} ************* `);
}

export async function retrieveResult<T = unknown>(filename: string): Promise<T> {
  const filePath = path.resolve(__dirname, `./${filename}.json`);
  const fileContent = fs.readFileSync(filePath, 'utf8');

  const parsed = JSON.parse(fileContent, (_, value) => {
    if (typeof value === 'string' && /^\d+$/.test(value)) {
      return BigInt(value);
    }
    return value;
  });

  return parsed as T;
}

async function storeResult(filename: string, data: object): Promise<void> {
  const current = await retrieveResult<BootstrapResult>(filename);

  const json = JSON.stringify(
    { ...current, ...data },
    (_, value) => (typeof value === 'bigint' ? value.toString() : value),
    2
  );
  const filePath = path.resolve(__dirname, `./${filename}.json`);

  return new Promise((resolve, reject) => {
    fs.writeFile(filePath, json, 'utf8', (err) => {
      if (err) {
        console.error(`❌ Errore durante la scrittura su ${filename}:`, err);
        reject(err);
      } else {
        console.log(`✅ Result of ${filename} saved: ${filePath}`);
        resolve();
      }
    });
  });
}

async function run(command: Commands): Promise<boolean> {
  title(command);

  switch (command) {
    case 'Create some Tokens': {
      const pepperAppID = await deployToken(`Pepper_${new Date().toString()}`);
      const pepperID = await tokenSetup(pepperAppID, 'Pepper', 'PPR');

      const cabbageAppID = await deployToken(`Cabbage_${new Date().toString()}`);
      const cabbageID = await tokenSetup(cabbageAppID, 'Cabbage', 'CBG');

      await storeResult('bootstrap', {
        TOKENS_APP: [pepperAppID, cabbageAppID],
        TOKENS: [pepperID, cabbageID],
      });

      break;
    }
    case 'Mint some Tokens': {
      const { rawAmount } = await inquirer.prompt([
        {
          type: 'number',
          name: 'rawAmount',
          message: 'How many tokens do you want?',
          default: 100,
        },
      ]);
      const amount = BigInt(rawAmount * 10 ** 6);

      const { TOKENS_APP } = await retrieveResult<BootstrapResult>('bootstrap');

      for (const token of TOKENS_APP) {
        await mintToken(token, amount);
      }
      break;
    }
    case 'Deploy & Bootstrap Factory': {
      const appID = await deploy(`Factory_${new Date().toString()}`);
      const { poolAppId } = await factorySetup(appID);

      await storeResult('bootstrap', {
        FACTORY_ID: appID,
        POOL_ID: poolAppId,
      });

      break;
    }
    case 'Write & Deploy Pool':
      const bootstrap = await retrieveResult<BootstrapResult>('bootstrap');

      const weights = bootstrap.TOKENS.map(() => BigInt((1 / bootstrap.TOKENS.length) * 1e6));

      await poolSetup(bootstrap.FACTORY_ID, bootstrap.POOL_ID, bootstrap.TOKENS, weights);
      break;
    case 'Add Liquidity':
      const { TOKENS } = await retrieveResult<BootstrapResult>('bootstrap');

      const { token, amount } = await inquirer.prompt([
        {
          type: 'list',
          name: 'token',
          message: 'Which token?',
          choices: TOKENS.map((v) => v.toString()),
        },
        {
          type: 'number',
          name: 'amount',
          message: 'How much?',
          default: 100,
        },
      ]);

      const tokenId = BigInt(parseInt(token, 10));
      await addLiquidity(tokenId, amount);

      console.log(`${amount} unit of token ${tokenId} provided`);
      break;
    case 'Quit':
      return true;
    default:
      console.log('This command does not exists');
  }

  return false;
}

async function main() {
  console.log('\n🚀 BALANCER SETUP');

  const { command } = await inquirer.prompt([
    {
      type: 'list',
      name: 'command',
      message: 'How do you want to procede?',
      choices: [
        'Create some Tokens',
        'Mint some Tokens',
        'Deploy & Bootstrap Factory',
        'Write & Deploy Pool',
        'Add Liquidity',
        'Quit',
      ],
    },
  ]);

  const stop = await run(command);
  if (!stop) await main();
}
main().catch(console.error);
