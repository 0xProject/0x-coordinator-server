import { PrivateKeyWalletSubprovider, RPCSubprovider, Web3ProviderEngine } from '@0x/subproviders';
import '@babel/polyfill';
import 'reflect-metadata';

import { getAppAsync } from './app';
import { getConfigs, initConfigs } from './configs';
import { utils } from './utils';

(async () => {
    const providerEngine = new Web3ProviderEngine();
    const privateKeyWalletSubprovider = new PrivateKeyWalletSubprovider(getConfigs().FEE_RECIPIENT_PRIVATE_KEY);
    providerEngine.addProvider(privateKeyWalletSubprovider);
    const rpcSubprovider = new RPCSubprovider(getConfigs().RPC_URL);
    providerEngine.addProvider(rpcSubprovider);
    providerEngine.start();

    initConfigs();
    const app = await getAppAsync(providerEngine);

    app.listen(getConfigs().HTTP_PORT, () => {
        utils.log(
            `Coordinator SERVER API (HTTP) listening on port ${getConfigs().HTTP_PORT}!\nConfig: ${JSON.stringify(
                getConfigs(),
                null,
                2,
            )}`,
        );
    });
})().catch(utils.log);
