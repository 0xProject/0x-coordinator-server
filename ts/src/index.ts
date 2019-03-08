import { PrivateKeyWalletSubprovider, RPCSubprovider, Web3ProviderEngine } from '@0x/subproviders';
import '@babel/polyfill';
import 'reflect-metadata';

import { getAppAsync } from './app';
import { configs } from './configs';
import { utils } from './utils';

(async () => {
    const providerEngine = new Web3ProviderEngine();
    const privateKeyWalletSubprovider = new PrivateKeyWalletSubprovider(configs.FEE_RECIPIENT_PRIVATE_KEY);
    providerEngine.addProvider(privateKeyWalletSubprovider);
    const rpcSubprovider = new RPCSubprovider(configs.RPC_URL);
    providerEngine.addProvider(rpcSubprovider);
    providerEngine.start();

    const app = await getAppAsync(providerEngine);

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
