import path from 'node:path';
import fs from 'node:fs';

export type BootstrapResult = {
  FACTORY_ID: bigint;
  POOL_ID: bigint;
  LP_TOKEN_ID: bigint;
  TOKENS: bigint[];
  TOKENS_APP: bigint[];
};

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

export async function storeResult(filename: string, data: object): Promise<void> {
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
