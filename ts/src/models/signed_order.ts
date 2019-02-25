import { getContractAddressesForNetworkOrThrow } from '@0x/contract-addresses';
import { orderHashUtils } from '@0x/order-utils';
import { Order } from '@0x/types';
import * as _ from 'lodash';

import { getDBConnection } from '../db_connection';
import { SignedOrderEntity } from '../entities/signed_order_entity';

import { NETWORK_ID } from '../config.js';

export const signedOrder = {
    async insertAsync(order: Order): Promise<SignedOrderEntity> {
        let signedOrderEntity = new SignedOrderEntity();
        const orderHash = signedOrder._getOrderHash(order);
        signedOrderEntity.orderHashHex = orderHash;
        signedOrderEntity.isCancelled = false;
        const connection = getDBConnection();
        signedOrderEntity = await connection.manager.save(SignedOrderEntity, signedOrderEntity);
        return signedOrderEntity;
    },
    async findAsync(order: Order): Promise<SignedOrderEntity | undefined> {
        const orderHash = signedOrder._getOrderHash(order);
        const connection = getDBConnection();
        const signedOrderIfExists = await connection.manager.findOne(SignedOrderEntity, orderHash);
        return signedOrderIfExists;
    },
    async isCancelledAsync(order: Order): Promise<boolean> {
        const signedOrderIfExists = await signedOrder.findAsync(order);
        return !_.isUndefined(signedOrderIfExists) && signedOrderIfExists.isCancelled;
    },
    async cancelAsync(order: Order): Promise<void> {
        const orderHash = signedOrder._getOrderHash(order);
        const connection = getDBConnection();
        const signedOrderIfExists = await connection.manager.findOne(SignedOrderEntity, orderHash);
        let signedOrderEntity: SignedOrderEntity;
        if (signedOrderIfExists === undefined) {
            signedOrderEntity = new SignedOrderEntity();
            signedOrderEntity.orderHashHex = orderHash;
            signedOrderEntity.isCancelled = true;
        } else {
            signedOrderEntity = signedOrderIfExists;
            signedOrderEntity.isCancelled = true;
        }
        await connection.manager.save(SignedOrderEntity, signedOrderEntity);
    },
    _getOrderHash(order: Order): string {
        const contractAddresses = getContractAddressesForNetworkOrThrow(NETWORK_ID);
        const orderWithExchangeAddress = {
            ...order,
            exchangeAddress: contractAddresses.exchange,
        };
        const orderHash = orderHashUtils.getOrderHashHex(orderWithExchangeAddress);
        return orderHash;
    },
};
