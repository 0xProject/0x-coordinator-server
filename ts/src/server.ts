import { RPCSubprovider, Web3ProviderEngine } from '@0x/subproviders';
import '@babel/polyfill';
import * as _ from 'lodash';
import 'reflect-metadata';

// import { configs } from './production_configs';
import { configs } from '../test/test_configs';

import { getAppAsync } from './app';
import { assertConfigsAreValid } from './assertions';
import { NetworkIdToProvider, NetworkSpecificSettings } from './types';
import { utils } from './utils';

(async () => {
    assertConfigsAreValid(configs);

    const networkIdToProvider: NetworkIdToProvider = {};
    _.each(configs.NETWORK_ID_TO_SETTINGS, (settings: NetworkSpecificSettings, networkIdStr: string) => {
        const providerEngine = new Web3ProviderEngine();
        const rpcSubprovider = new RPCSubprovider(settings.RPC_URL);
        providerEngine.addProvider(rpcSubprovider);
        // HACK(fabio): Starting the provider this way avoids it's unused block poller from running
        (providerEngine as any)._ready.go();
        const networkId = _.parseInt(networkIdStr);
        networkIdToProvider[networkId] = providerEngine;
    });

    const app = await getAppAsync(networkIdToProvider, configs);

    app.listen(configs.HTTP_PORT, () => {
        utils.log(`Coordinator SERVER API (HTTP) listening on port ${configs.HTTP_PORT}!`);
    });
})().catch(utils.log);
