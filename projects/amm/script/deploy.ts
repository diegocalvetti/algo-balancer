/* eslint-disable no-console */

import { deployToken, tokenSetup, deploy, factorySetup } from '../utils/bootstrap';

(async () => {
  const cubaID = await deployToken(`Cuba_${new Date().toString()}`);
  await tokenSetup(cubaID);

  const treeftyID = await deployToken(`Treefty_${new Date().toString()}`);
  await tokenSetup(treeftyID);

  const appID = await deploy(`Factory_${new Date().toString()}`);
  await factorySetup(appID);
})();
