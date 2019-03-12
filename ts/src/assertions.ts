// tslint:disable:custom-no-magic-numbers
import { BigNumber } from '0x.js';
import { assert } from '@0x/assert';
import * as _ from 'lodash';

import { constants } from './constants';
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
    if (_.isEmpty(configs.FEE_RECIPIENT_PRIVATE_KEY) || configs.FEE_RECIPIENT === constants.PLACEHOLDER) {
        throw new Error('FEE_RECIPIENT_PRIVATE_KEY must be specified');
    }
    if (_.isEmpty(configs.FEE_RECIPIENT) || configs.FEE_RECIPIENT_PRIVATE_KEY === constants.PLACEHOLDER) {
        throw new Error('FEE_RECIPIENT must be specified');
    }

    assertEnvVarType('HTTP_PORT', configs.HTTP_PORT, EnvVarType.Port);
    assertEnvVarType('NETWORK_ID', configs.NETWORK_ID, EnvVarType.Integer);
    assertEnvVarType('RPC_URL', configs.RPC_URL, EnvVarType.Url);
    assertEnvVarType('FEE_RECIPIENT', configs.FEE_RECIPIENT, EnvVarType.FeeRecipient);
    assertEnvVarType('FEE_RECIPIENT_PRIVATE_KEY', configs.FEE_RECIPIENT_PRIVATE_KEY, EnvVarType.FeeRecipientPrivateKey);
    assertEnvVarType('SELECTIVE_DELAY_MS', configs.SELECTIVE_DELAY_MS, EnvVarType.Integer);
    assertEnvVarType('EXPIRATION_DURATION_SECONDS', configs.EXPIRATION_DURATION_SECONDS, EnvVarType.Integer);
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

        case EnvVarType.FeeRecipient:
            assert.isETHAddressHex(name, value);
            return value;

        case EnvVarType.FeeRecipientPrivateKey:
            assert.isString(name, value);
            return value;

        case EnvVarType.Url:
            assert.isUri(name, value);
            return value;

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
