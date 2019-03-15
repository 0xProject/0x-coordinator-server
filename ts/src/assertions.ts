// tslint:disable:custom-no-magic-numbers
import { assert } from '@0x/assert';
import * as _ from 'lodash';

import { Configs, FeeRecipient, NetworkSpecificSettings } from './types';
import { utils } from './utils';

enum EnvVarType {
    Port,
    Integer,
}

/**
 * Assert that the configs supplied are valid
 * @param configs Configs
 */
export function assertConfigsAreValid(configs: Configs): void {
    assertEnvVarType('HTTP_PORT', configs.HTTP_PORT, EnvVarType.Port);
    assertEnvVarType('SELECTIVE_DELAY_MS', configs.SELECTIVE_DELAY_MS, EnvVarType.Integer);
    assertEnvVarType('EXPIRATION_DURATION_SECONDS', configs.EXPIRATION_DURATION_SECONDS, EnvVarType.Integer);

    const networkIds = _.keys(configs.NETWORK_ID_TO_SETTINGS);
    _.each(networkIds, networkId => assert.isNumber('networkId', _.parseInt(networkId)));
    const networkSpecificSettings = _.values(configs.NETWORK_ID_TO_SETTINGS);
    _.each(networkSpecificSettings, (settings: NetworkSpecificSettings) => {
        _.each(settings.FEE_RECIPIENTS, (feeRecipient: FeeRecipient, i: number) => {
            assert.isETHAddressHex(`settings.FEE_RECIPIENTS[${i}].ADDRESS`, feeRecipient.ADDRESS);
            assert.isString(`settings.FEE_RECIPIENTS[${i}].PRIVATE_KEY`, feeRecipient.PRIVATE_KEY);
            const recoveredAddress = utils.getAddressFromPrivateKey(feeRecipient.PRIVATE_KEY);
            if (recoveredAddress !== feeRecipient.ADDRESS) {
                throw new Error(
                    `FeeRecipientAddress ${feeRecipient.ADDRESS} does not correspond to the private key ${
                        feeRecipient.PRIVATE_KEY
                    }`,
                );
            }
        });
        assert.isUri('settings.RPC_URL', settings.RPC_URL);
    });
}

function assertEnvVarType(name: string, value: any, expectedType: EnvVarType): any {
    let returnValue;
    switch (expectedType) {
        case EnvVarType.Port:
            try {
                returnValue = parseInt(value, 10);
                const isWithinRange = returnValue >= 0 && returnValue <= 65535;
                if (!isWithinRange) {
                    throw new Error();
                }
            } catch (err) {
                throw new Error(`${name} must be between 0 to 65535, found ${value}.`);
            }
            return returnValue;

        case EnvVarType.Integer:
            try {
                returnValue = parseInt(value, 10);
            } catch (err) {
                throw new Error(`${name} must be a valid integer, found ${value}.`);
            }
            return returnValue;

        default:
            throw new Error(`Unrecognised EnvVarType: ${expectedType} encountered for variable ${name}.`);
    }
}
