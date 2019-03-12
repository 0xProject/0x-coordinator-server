import { PrivateKeyWalletSubprovider, RPCSubprovider, Web3ProviderEngine } from '@0x/subproviders';
import '@babel/polyfill';
import 'reflect-metadata';

import { getAppAsync } from './app';
import { assertConfigsAreValid } from './assertions';
import { configs } from './production_configs';
import { utils } from './utils';

(async () => {
    assertConfigsAreValid(configs);

    const providerEngine = new Web3ProviderEngine();
    const privateKeyWalletSubprovider = new PrivateKeyWalletSubprovider(configs.FEE_RECIPIENT_PRIVATE_KEY);
    providerEngine.addProvider(privateKeyWalletSubprovider);
    const rpcSubprovider = new RPCSubprovider(configs.RPC_URL);
    providerEngine.addProvider(rpcSubprovider);
    providerEngine.start();

    const app = await getAppAsync(providerEngine, configs);

    app.listen(configs.HTTP_PORT, () => {
        utils.log(
            `Coordinator SERVER API (HTTP) listening on port ${configs.HTTP_PORT}!\nConfig: ${JSON.stringify(
                configs,
                null,
                2,
            )}`,
        );
    });
})().catch(utils.log);
