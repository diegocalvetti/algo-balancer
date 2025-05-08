/* eslint-disable no-console, no-case-declarations, import/no-extraneous-dependencies, no-await-in-loop, no-restricted-syntax */
import inquirer from 'inquirer';
import path from 'node:path';
import fs from 'node:fs';
import { deploy, deployToken, factorySetup, mintToken, poolSetup, tokenSetup } from '../utils/bootstrap';
import { addLiquidity, computeLiquidity, swap } from '../utils/amm';

export type BootstrapResult = { FACTORY_ID: bigint; POOL_ID: bigint; TOKENS: bigint[]; TOKENS_APP: bigint[] };

const choices = [
  'Create some Tokens',
  'Mint some Tokens',
  'Deploy & Bootstrap Factory',
  'Write & Deploy Pool',
  'Add Liquidity',
  'Compute Liquidity',
  'Swap',
  'Quit',
] as const;
let currentChoice = 0;

type Commands = (typeof choices)[number];

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
  const { FACTORY_ID, POOL_ID, TOKENS } = await retrieveResult<BootstrapResult>('bootstrap');

  switch (command) {
    case 'Create some Tokens': {
      const pepperAppID = await deployToken(`Pepper_${new Date().toString()}`);
      const pepperID = await tokenSetup(pepperAppID, 'Pepper', 'PPR');

      const cabbageAppID = await deployToken(`Cabbage_${new Date().toString()}`);
      const cabbageID = await tokenSetup(cabbageAppID, 'Cabbage', 'CBG');

      const fennelAppID = await deployToken(`Fennel_${new Date().toString()}`);
      const fennelID = await tokenSetup(fennelAppID, 'Fennel', 'FNL');

      await storeResult('bootstrap', {
        TOKENS_APP: [pepperAppID, cabbageAppID, fennelAppID],
        TOKENS: [pepperID, cabbageID, fennelID],
      });

      break;
    }
    case 'Mint some Tokens': {
      const { rawAmount } = await inquirer.prompt([
        {
          type: 'number',
          name: 'rawAmount',
          message: 'How many tokens do you want?',
          default: 10_000,
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
      const weights = [1 / 2, 1 / 4, 1 / 4].map((n) => BigInt(n * 1e6));

      await poolSetup(FACTORY_ID, POOL_ID, TOKENS, weights);
      break;
    case 'Add Liquidity':
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
    case 'Compute Liquidity':
      await computeLiquidity();

      console.log(`LP calculations done`);
      break;
    case 'Swap':
      const { tokenIn, amountIn, tokenOut } = await inquirer.prompt([
        {
          type: 'list',
          name: 'tokenIn',
          message: 'Which token do you want to put in?',
          choices: TOKENS.map((v) => v.toString()),
        },
        {
          type: 'number',
          name: 'amountIn',
          message: 'How much?',
          default: 100,
        },
        {
          type: 'list',
          name: 'tokenOut',
          message: 'Which token do you want to swap for?',
          choices: TOKENS.map((v) => v.toString()),
        },
      ]);

      const tokenInID = BigInt(parseInt(tokenIn, 10));
      const tokenOutID = BigInt(parseInt(tokenOut, 10));
      await swap(FACTORY_ID, POOL_ID, tokenInID, tokenOutID, amountIn);

      console.log('Swapped!');
      break;
    case 'Quit':
      return true;
    default:
      console.log('This command does not exists');
  }

  currentChoice = choices.indexOf(command);

  return false;
}

async function main() {
  console.log('\n🚀 BALANCER SETUP');

  const { command } = await inquirer.prompt([
    {
      type: 'list',
      name: 'command',
      message: 'How do you want to procede?',
      default: choices[currentChoice],
      choices,
    },
  ]);

  const stop = await run(command);
  if (!stop) await main();
}

main().catch(console.error);
