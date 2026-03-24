/* eslint-disable no-console, no-case-declarations, import/no-cycle, import/no-extraneous-dependencies, no-await-in-loop, no-restricted-syntax */
import inquirer from 'inquirer';
import * as algokit from '@algorandfoundation/algokit-utils';
import dotenv from 'dotenv';
import { createToken, mintToken } from '../helpers/token';
import { deploy, factorySetup } from '../helpers/factory';
import {
  addLiquidity,
  burnLiquidity,
  getAuctionState,
  getLiquidity,
  getPool,
  getPoolTypeName,
  initPool,
  PoolTypes,
  swap,
} from '../helpers/pool';
import { getFactoryClient, retrieveResult, storeResult } from '../helpers/generic';
import { FactoryClient } from '../contracts/clients/FactoryClient';
import { bid, claimRewards, settle } from '../helpers/poolAuction';

dotenv.config();

export type BootstrapResult = {
  FACTORY_ID: bigint;
  POOL_ID: bigint;
  LP_TOKEN_ID: bigint;
  TOKENS: bigint[];
  TOKENS_APP: bigint[];
  POOL_TYPE: PoolTypes;
};

const choices = [
  'Create some Tokens',
  'Mint some Tokens',
  'Deploy & Bootstrap Factory',
  'Write & Deploy Pool',
  'Add Liquidity',
  'Compute Liquidity',
  'Burn Liquidity',
  'Swap',
  'Bid',
  'Settle',
  'Burn Liquidity (Auction)',
  'Info',
  'Quit',
] as const;
type Commands = (typeof choices)[number];
let currentChoice = 0;

const algorand = algokit.AlgorandClient.defaultLocalNet();
const account = algorand.account.fromMnemonic(process.env.ACCOUNT_MNEMONIC!);
const manager = { algorand, sender: account.addr, signer: account.signer };
let poolType: PoolTypes = PoolTypes.Vault;

function title(text: string): void {
  console.log(`************* ${text.toUpperCase()} ************* `);
}

async function run(command: Commands): Promise<boolean> {
  title(command);
  const { FACTORY_ID, POOL_ID, TOKENS, LP_TOKEN_ID, POOL_TYPE } =
    await retrieveResult<BootstrapResult>('../script/bootstrap');

  let factoryClient: FactoryClient;

  switch (command) {
    case 'Create some Tokens': {
      const NEW_TOKENS_APP = [];
      const NEW_TOKENS = [];
      console.log('Create!!!');

      for (const name of [
        `Pepper_${new Date().toString().substring(0, 21)}`,
        `Cabbage_${new Date().toString().substring(0, 21)}`,
      ]) {
        console.log(name);
        const { appID, assetID } = await createToken(manager, name, name.substring(0, 3).toUpperCase());
        NEW_TOKENS_APP.push(appID);
        NEW_TOKENS.push(assetID);
      }

      await storeResult('../script/bootstrap', {
        TOKENS_APP: NEW_TOKENS_APP,
        TOKENS: NEW_TOKENS,
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

      const { TOKENS_APP } = await retrieveResult<BootstrapResult>('../script/bootstrap');

      // eslint-disable-next-line guard-for-in
      for (const index in TOKENS_APP) {
        const token = {
          appID: TOKENS_APP[index],
          assetID: TOKENS[index],
        };
        await mintToken(manager, token, amount);
      }
      break;
    }
    case 'Deploy & Bootstrap Factory': {
      const appID = await deploy(manager, `Factory_${new Date().toString()}`);

      const { type } = await inquirer.prompt([
        {
          type: 'list',
          name: 'type',
          message: 'Which type of pool do you want?',
          choices: ['Vault', 'WAP'],
        },
      ]);
      poolType = type === 'WAP' ? PoolTypes.Dex : PoolTypes.Vault;

      const { poolAppId } = await factorySetup(manager, poolType, appID);

      await storeResult('../script/bootstrap', {
        FACTORY_ID: appID,
        POOL_ID: poolAppId,
        POOL_TYPE: poolType,
      });

      break;
    }
    case 'Write & Deploy Pool':
      factoryClient = await getFactoryClient(manager, FACTORY_ID);
      const weights = [1 / 2, 1 / 2];

      let existingPool = null;
      try {
        existingPool = await getPool(factoryClient, TOKENS, weights);
      } catch (e) {
        /* empty */
      }

      if (existingPool) {
        console.log(`Pool ${existingPool} already exists! => (${TOKENS}) (${weights})`);
        break;
      }

      const lpTokenID = await initPool(factoryClient, manager, poolType, POOL_ID, TOKENS, weights);
      await storeResult('../script/bootstrap', { LP_TOKEN_ID: lpTokenID });
      break;
    case 'Add Liquidity':
      factoryClient = await getFactoryClient(manager, FACTORY_ID);
      const { type } = await inquirer.prompt([
        {
          type: 'list',
          name: 'type',
          message: 'Which mode?',
          choices: ['All the tokens proportional to weights', 'Single Token'],
        },
      ]);

      if (type === 'Single Token') {
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
        await addLiquidity(manager, poolType, POOL_ID, amount, [tokenId]);
        console.log(`${amount} unit of token ${tokenId} provided`);
      } else {
        const { amount } = await inquirer.prompt([
          {
            type: 'number',
            name: 'amount',
            message: 'How much?',
            default: 100,
          },
        ]);

        await addLiquidity(manager, poolType, POOL_ID, amount, TOKENS);
      }
      break;
    case 'Compute Liquidity':
      factoryClient = await getFactoryClient(manager, FACTORY_ID);
      const LP = await getLiquidity(manager, poolType, POOL_ID);
      console.log(`LP calculations done => ${LP} LP received`);
      break;
    case 'Burn Liquidity':
      const { amountLP } = await inquirer.prompt([
        {
          type: 'number',
          name: 'amountLP',
          message: 'How much?',
          default: 100,
        },
      ]);
      factoryClient = await getFactoryClient(manager, FACTORY_ID);
      await burnLiquidity(manager, poolType, POOL_ID, LP_TOKEN_ID, amountLP);

      console.log(`LP burned`);
      break;
    case 'Swap':
      factoryClient = await getFactoryClient(manager, FACTORY_ID);
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

      const tokenInIndex = TOKENS.findIndex((el) => el.toString() === tokenIn);
      const tokenOutIndex = TOKENS.findIndex((el) => el.toString() === tokenOut);

      await swap(manager, poolType, POOL_ID, TOKENS, tokenInIndex, tokenOutIndex, amountIn);
      break;
    case 'Bid':
      if (POOL_TYPE !== PoolTypes.Dex) {
        console.log(`Auction not available in ${getPoolTypeName(PoolTypes.Vault)}`);
        break;
      }

      const { amountBid } = await inquirer.prompt([
        {
          type: 'number',
          name: 'amountBid',
          message: 'How much?',
          default: 1,
        },
      ]);

      const tx = await bid(manager, POOL_ID, amountBid);
      console.log(tx.txIds);

      break;
    case 'Settle':
      if (POOL_TYPE !== PoolTypes.Dex) {
        console.log(`Auction not available in ${getPoolTypeName(PoolTypes.Vault)}`);
        break;
      }

      const settleResponse = await settle(manager, POOL_ID);
      console.log(settleResponse.txIds);

      break;
    case 'Burn Liquidity (Auction)':
      const { amountLPAuction } = await inquirer.prompt([
        {
          type: 'number',
          name: 'amountLPAuction',
          message: 'How much?',
          default: 100,
        },
      ]);

      const claimResponse = await claimRewards(manager, poolType, POOL_ID, LP_TOKEN_ID, amountLPAuction);
      console.log(claimResponse.txIds);

      break;
    case 'Info':
      console.log({
        FACTORY_ID,
        POOL_ID,
        TOKENS,
        LP_TOKEN_ID,
        POOL_TYPE: `${POOL_TYPE} (${getPoolTypeName(POOL_TYPE)})`,
      });

      if (POOL_TYPE === PoolTypes.Dex) {
        const auction = await getAuctionState(manager, POOL_TYPE, POOL_ID);
        console.log('\n\nAUCTION:');
        console.log({
          auctionEnd: auction[0],
          epochEnd: auction[1],
          highestBid: auction[2],
          feeRate: auction[3],
          rewardPool: auction[4],
          globalsRound: auction[5],
        });
      }

      break;
    case 'Quit':
      return true;
    default:
      console.log('This command does not exists');
  }

  currentChoice = choices.indexOf(command) + 1;

  return false;
}

async function main() {
  console.log('\n🚀 BALANCER SETUP V2');

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
