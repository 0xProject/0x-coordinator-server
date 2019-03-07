// tslint:disable:custom-no-magic-numbers
import { BigNumber } from '0x.js';
import { assert } from '@0x/assert';
import * as _ from 'lodash';

enum EnvVarType {
    Port,
    Integer,
    FeeRecipient,
    FeeRecipientPrivateKey,
    UnitAmount,
    Url,
}

// Network port to listen on
export const HTTP_PORT = _.isEmpty(process.env.HTTP_PORT)
    ? 3000
    : assertEnvVarType('HTTP_PORT', process.env.HTTP_PORT, EnvVarType.Port);

// Default network id to use when not specified
export const NETWORK_ID = _.isEmpty(process.env.NETWORK_ID)
    ? 42
    : assertEnvVarType('NETWORK_ID', process.env.NETWORK_ID, EnvVarType.Integer);

// Ethereum RPC url
export const RPC_URL = _.isEmpty(process.env.RPC_URL)
    ? 'https://kovan.infura.io/v3/e2c067d9717e492091d1f1d7a2ec55aa'
    : assertEnvVarType('RPC_URL', process.env.RPC_URL, EnvVarType.Url);

// The fee recipient for orders
if (_.isEmpty(process.env.FEE_RECIPIENT)) {
    throw new Error('FEE_RECIPIENT must be specified');
}
export const FEE_RECIPIENT = assertEnvVarType('FEE_RECIPIENT', process.env.FEE_RECIPIENT, EnvVarType.FeeRecipient);

// The fee recipient address private key
if (_.isEmpty(process.env.FEE_RECIPIENT_PRIVATE_KEY)) {
    throw new Error('FEE_RECIPIENT_PRIVATE_KEY must be specified');
}
export const FEE_RECIPIENT_PRIVATE_KEY = assertEnvVarType(
    'FEE_RECIPIENT_PRIVATE_KEY',
    process.env.FEE_RECIPIENT_PRIVATE_KEY,
    EnvVarType.FeeRecipientPrivateKey,
);

// Optional selective delay on fill requests
export const SELECTIVE_DELAY_MS = _.isEmpty(process.env.SELECTIVE_DELAY_MS)
    ? 1000
    : assertEnvVarType('SELECTIVE_DELAY_MS', process.env.SELECTIVE_DELAY_MS, EnvVarType.Integer);

export const EXPIRATION_DURATION_SECONDS = _.isEmpty(process.env.EXPIRATION_DURATION_SECONDS)
    ? 60 // 1 minute
    : (assertEnvVarType(
          'EXPIRATION_DURATION_SECONDS',
          process.env.EXPIRATION_DURATION_SECONDS,
          EnvVarType.Integer,
      ) as number);

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
