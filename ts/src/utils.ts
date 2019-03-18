import { Schema, SchemaValidator } from '@0x/json-schemas';
import { eip712Utils, transactionHashUtils } from '@0x/order-utils';
import { constants as orderUtilsConstants } from '@0x/order-utils/lib/src/constants';
import { OrderWithoutExchangeAddress, SignedOrder, SignedZeroExTransaction, ZeroExTransaction } from '@0x/types';
import { BigNumber, signTypedDataUtils } from '@0x/utils';
import * as ethUtil from 'ethereumjs-util';
import { ValidationError as SchemaValidationError } from 'jsonschema';
import * as _ from 'lodash';

import { ValidationError, ValidationErrorCodes, ValidationErrorItem } from './errors';
import { Configs } from './types';

const schemaValidator = new SchemaValidator();

export const utils = {
    log: (...args: any[]) => {
        // tslint:disable-next-line:no-console
        console.log(...args);
    },
    validateSchema(instance: any, schema: Schema): void {
        const validationResult = schemaValidator.validate(instance, schema);
        if (_.isEmpty(validationResult.errors)) {
            return;
        } else {
            const validationErrorItems = _.map(
                validationResult.errors,
                (schemaValidationError: SchemaValidationError) =>
                    schemaValidationErrorToValidationErrorItem(schemaValidationError),
            );
            throw new ValidationError(validationErrorItems);
        }
    },
    getInvalidFunctionCallError(functionName: string): ValidationError {
        return new ValidationError([
            {
                field: 'signedTransaction.data',
                code: ValidationErrorCodes.FunctionCallUnsupported,
                reason: `Function call encoded in 0x transaction data unsupported: ${functionName}`,
            },
        ]);
    },
    getAddressFromPrivateKey(privateKey: string): string {
        const addressBuf = ethUtil.privateToAddress(Buffer.from(privateKey, 'hex'));
        const address = ethUtil.addHexPrefix(addressBuf.toString('hex'));
        return address;
    },
    getSupportedNetworkIds(configs: Configs): number[] {
        const supportedNetworkIds = _.map(_.keys(configs.NETWORK_ID_TO_SETTINGS), networkIdStr =>
            _.parseInt(networkIdStr),
        );
        return supportedNetworkIds;
    },
    getCurrentTimestampSeconds(): number {
        return Math.round(Date.now() / 1000);
    },
    async sleepAsync(miliseconds: number): Promise<void> {
        await new Promise<void>(resolve => setTimeout(resolve, miliseconds));
    },
    convertToUnsignedOrder(order: SignedOrder): OrderWithoutExchangeAddress {
        const orderWithoutExchangeAddress = {
            ...order,
        };
        delete orderWithoutExchangeAddress.signature;
        return orderWithoutExchangeAddress;
    },
    getSignedOrdersFromOrderWithoutExchangeAddresses(
        orders: OrderWithoutExchangeAddress[],
        signatures: string[],
        exchangeAddress: string,
    ): SignedOrder[] {
        const signedOrders: SignedOrder[] = _.map(orders, (o: any, i: number) => {
            o.signature = signatures[i];
            o.exchangeAddress = exchangeAddress;
            return o;
        });
        return signedOrders;
    },
    getUnsignedTransaction(signedTransaction: SignedZeroExTransaction): ZeroExTransaction {
        const unsignedTransaction = _.clone(signedTransaction);
        delete unsignedTransaction.signature;
        return unsignedTransaction;
    },
    getUnmarshalledObject(o: any): any {
        return JSON.parse(JSON.stringify(o));
    },
    getApprovalHashBuffer(
        transaction: SignedZeroExTransaction,
        verifyingContractAddress: string,
        txOrigin: string,
        approvalExpirationTimeSeconds: BigNumber,
    ): Buffer {
        const domain = {
            name: orderUtilsConstants.COORDINATOR_DOMAIN_NAME,
            version: orderUtilsConstants.COORDINATOR_DOMAIN_VERSION,
            verifyingContractAddress,
        };
        const transactionHash = transactionHashUtils.getTransactionHashHex(transaction);
        const approval = {
            txOrigin,
            transactionHash,
            transactionSignature: transaction.signature,
            approvalExpirationTimeSeconds: approvalExpirationTimeSeconds.toString(),
        };
        const typedData = eip712Utils.createTypedData(
            orderUtilsConstants.COORDINATOR_APPROVAL_SCHEMA.name,
            {
                CoordinatorApproval: orderUtilsConstants.COORDINATOR_APPROVAL_SCHEMA.parameters,
            },
            approval,
            domain,
        );
        const hashBuffer = signTypedDataUtils.generateTypedDataHash(typedData);
        return hashBuffer;
    },
};

function schemaValidationErrorToValidationErrorItem(schemaValidationError: SchemaValidationError): ValidationErrorItem {
    if (
        _.includes(
            [
                'type',
                'anyOf',
                'allOf',
                'oneOf',
                'additionalProperties',
                'minProperties',
                'maxProperties',
                'pattern',
                'format',
                'uniqueItems',
                'items',
                'dependencies',
            ],
            schemaValidationError.name,
        )
    ) {
        return {
            field: schemaValidationError.property,
            code: ValidationErrorCodes.IncorrectFormat,
            reason: schemaValidationError.message,
        };
    } else if (
        _.includes(
            ['minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems', 'enum', 'const'],
            schemaValidationError.name,
        )
    ) {
        return {
            field: schemaValidationError.property,
            code: ValidationErrorCodes.ValueOutOfRange,
            reason: schemaValidationError.message,
        };
    } else if (schemaValidationError.name === 'required') {
        return {
            field: schemaValidationError.argument,
            code: ValidationErrorCodes.RequiredField,
            reason: schemaValidationError.message,
        };
    } else if (schemaValidationError.name === 'not') {
        return {
            field: schemaValidationError.property,
            code: ValidationErrorCodes.UnsupportedOption,
            reason: schemaValidationError.message,
        };
    } else {
        throw new Error(`Unknnown schema validation error name: ${schemaValidationError.name}`);
    }
}
