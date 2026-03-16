import { AssetVaultClient } from '../contracts/clients/AssetVaultClient';

const SCALE = BigInt(1_000_000);

function ln(x: bigint): { negative: boolean; value: bigint } {
  let z: bigint;
  let negative = false;

  if (x < SCALE) {
    negative = true;
    const invX = (SCALE * SCALE) / x;
    z = ((invX - SCALE) * SCALE) / invX;
  } else {
    z = ((x - SCALE) * SCALE) / x;
  }

  let result = z;
  let term = z;
  let neg = false;

  for (let i = BigInt(2); i <= BigInt(10); i += BigInt(1)) {
    term = (term * z) / SCALE;
    const delta = term / i;
    result = neg ? result - delta : result + delta;
    neg = !neg;
  }

  return { negative, value: result };
}

function exp(x: bigint): bigint {
  let result = SCALE;
  let term = SCALE;

  for (let i = BigInt(1); i <= BigInt(10); i += BigInt(1)) {
    term = (term * x) / (i * SCALE);
    result += term;
  }

  return result;
}

function pow(x: bigint, y: bigint): bigint {
  if (x === BigInt(0)) return BigInt(0);

  const { negative, value: lnX } = ln(x);
  const ylnX = (y * lnX) / SCALE;
  const expResult = exp(ylnX);

  return negative ? (SCALE * SCALE) / expResult : expResult;
}

function calcSwapOffChain(
  balanceIn: bigint,
  weightIn: bigint,
  balanceOut: bigint,
  weightOut: bigint,
  amountIn: bigint
): bigint {
  const fee = BigInt(1_000);
  const amountInWithFee = (amountIn * (SCALE - fee)) / SCALE;
  const ratio = (balanceIn * SCALE) / (balanceIn + amountInWithFee);
  const power = (weightIn * SCALE) / weightOut;
  const ratioPow = pow(ratio, power);
  return (balanceOut * (SCALE - ratioPow)) / SCALE;
}

export async function estimateSwapOffChain(poolClient: AssetVaultClient, from: number, to: number, amount: bigint) {
  const wIn = await poolClient.getWeight({ args: [from] });
  const wOut = await poolClient.getWeight({ args: [to] });
  const bIn = await poolClient.getBalance({ args: [from] });
  const bOut = await poolClient.getBalance({ args: [to] });

  return calcSwapOffChain(bIn, wIn, bOut, wOut, amount);
}
