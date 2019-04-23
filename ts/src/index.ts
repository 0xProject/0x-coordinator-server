import { RPCSubprovider, Web3ProviderEngine } from '@0x/subproviders';
import '@babel/polyfill';
import * as _ from 'lodash';
import 'reflect-metadata';

import { configs as testConfigs } from '../test/test_configs';

import { getAppAsync } from './app';
import { assertConfigsAreValid } from './assertions';
import { configs  as productionConfigs } from './production_configs';
import { NetworkIdToProvider, NetworkSpecificSettings } from './types';
import { utils } from './utils';

export { getAppAsync };

export const configs = {
    production: productionConfigs,
    test: testConfigs,
};

(async () => {
    assertConfigsAreValid(productionConfigs);

    const networkIdToProvider: NetworkIdToProvider = {};
    _.each(productionConfigs.NETWORK_ID_TO_SETTINGS, (settings: NetworkSpecificSettings, networkIdStr: string) => {
        const providerEngine = new Web3ProviderEngine();
        const rpcSubprovider = new RPCSubprovider(settings.RPC_URL);
        providerEngine.addProvider(rpcSubprovider);
        // HACK(fabio): Starting the provider this way avoids it's unused block poller from running
        (providerEngine as any)._ready.go();
        const networkId = _.parseInt(networkIdStr);
        networkIdToProvider[networkId] = providerEngine;
    });

    const app = await getAppAsync(networkIdToProvider, productionConfigs);

    app.listen(productionConfigs.HTTP_PORT, () => {
        utils.log(`Coordinator SERVER API (HTTP) listening on port ${productionConfigs.HTTP_PORT}!`);
    });
})().catch(utils.log);
