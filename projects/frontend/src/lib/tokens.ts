import BOOTSTRAP from "../../../amm/script/bootstrap.json";
import {type Asset, detailAsset} from "$lib/algorand";

const EXTRA_TOKENS: string[] = ["0"];

export async function getTokens(): Promise<Asset[]> {
  let tokens = [];

  for (const token of [...EXTRA_TOKENS, ...BOOTSTRAP.TOKENS]) {
    tokens.push(await detailAsset(token))
  }

  return [...tokens]
}

export async function getTokensWithout(without: bigint[] = []): Promise<Asset[]> {
  let tokens = await getTokens();
  return tokens.filter(token => !without.includes(token.id));
}

export async function getToken(id: bigint|string): Promise<Asset> {
  return await detailAsset(id);
}
