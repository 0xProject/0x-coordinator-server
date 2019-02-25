import { PrivateKeyWalletSubprovider, RPCSubprovider, Web3ProviderEngine } from '@0x/subproviders';
import '@babel/polyfill';
import 'reflect-metadata';

import { getAppAsync } from './app';
import * as config from './config';
import { utils } from './utils';

(async () => {
    const providerEngine = new Web3ProviderEngine();
    const privateKeyWalletSubprovider = new PrivateKeyWalletSubprovider(config.FEE_RECIPIENT_PRIVATE_KEY);
    providerEngine.addProvider(privateKeyWalletSubprovider);
    const rpcSubprovider = new RPCSubprovider(config.RPC_URL);
    providerEngine.addProvider(rpcSubprovider);
    providerEngine.start();

    const app = await getAppAsync(providerEngine);

    app.listen(config.HTTP_PORT, () => {
        utils.log(
            `TEC SERVER API (HTTP) listening on port ${config.HTTP_PORT}!\nConfig: ${JSON.stringify(config, null, 2)}`,
        );
    });
})().catch(utils.log);
