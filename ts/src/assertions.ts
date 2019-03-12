// tslint:disable:custom-no-magic-numbers
import { BigNumber } from '0x.js';
import { assert } from '@0x/assert';
import * as _ from 'lodash';

import { Configs } from './types';

enum EnvVarType {
    Port,
    Integer,
    FeeRecipient,
    FeeRecipientPrivateKey,
    UnitAmount,
    Url,
}

export function assertConfigsAreValid(configs: Configs): void {
    assertEnvVarType('HTTP_PORT', configs.HTTP_PORT, EnvVarType.Port);
    assertEnvVarType('SELECTIVE_DELAY_MS', configs.SELECTIVE_DELAY_MS, EnvVarType.Integer);
    assertEnvVarType('EXPIRATION_DURATION_SECONDS', configs.EXPIRATION_DURATION_SECONDS, EnvVarType.Integer);

    const networkIds = _.keys(configs.NETWORK_ID_TO_SETTINGS);
    _.each(networkIds, networkId => assert.isNumber('networkId', _.parseInt(networkId)));
    const networkSpecificSettings = _.values(configs.NETWORK_ID_TO_SETTINGS);
    _.each(networkSpecificSettings, settings => {
        assert.isETHAddressHex('settings.FEE_RECIPIENT_ADDRESS', settings.FEE_RECIPIENT_ADDRESS);
        assert.isString('settings.FEE_RECIPIENT_PRIVATE_KEY', settings.FEE_RECIPIENT_PRIVATE_KEY);
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

        case EnvVarType.UnitAmount:
            try {
                returnValue = new BigNumber(parseFloat(value));
                if (returnValue.isNegative) {
                    throw new Error();
                }
            } catch (err) {
                throw new Error(`${name} must be valid number greater than 0.`);
            }
            return returnValue;

        default:
            throw new Error(`Unrecognised EnvVarType: ${expectedType} encountered for variable ${name}.`);
    }
}
