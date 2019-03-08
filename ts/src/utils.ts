import { Schema, SchemaValidator } from '@0x/json-schemas';
import { OrderWithoutExchangeAddress, SignedOrder, SignedZeroExTransaction, ZeroExTransaction } from '@0x/types';
import { ValidationError as SchemaValidationError } from 'jsonschema';
import * as _ from 'lodash';

import { FEE_RECIPIENT } from './config';
import { ValidationError, ValidationErrorCodes, ValidationErrorItem } from './errors';

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
    getCurrentTimestampSeconds(): number {
        return Math.round(Date.now() / 1000);
    },
    // TODO(fabio): Allow operator to specify multiple feeRecipientAddresses
    isCoordinatorFeeRecipient(feeRecipientAddress: string): boolean {
        return feeRecipientAddress === FEE_RECIPIENT;
    },
    async sleepAsync(miliseconds: number): Promise<void> {
        await new Promise<void>(resolve => setTimeout(resolve, miliseconds));
    },
    getOrderWithoutExchangeAddress(order: SignedOrder): OrderWithoutExchangeAddress {
        const orderWithoutExchangeAddress = {
            ...order,
        };
        delete orderWithoutExchangeAddress.exchangeAddress;
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
