import { getContractAddressesForNetworkOrThrow } from '@0x/contract-addresses';
import { orderHashUtils } from '@0x/order-utils';
import { OrderWithoutExchangeAddress } from '@0x/types';
import * as _ from 'lodash';

import { NETWORK_ID } from '../config.js';
import { getDBConnection } from '../db_connection';
import { SignedOrderEntity } from '../entities/signed_order_entity';

export const signedOrder = {
    async createAsync(order: OrderWithoutExchangeAddress): Promise<SignedOrderEntity> {
        let signedOrderEntity = new SignedOrderEntity();
        const orderHash = signedOrder.getOrderHash(order);
        signedOrderEntity.orderHashHex = orderHash;
        signedOrderEntity.isCancelled = false;

        const connection = getDBConnection();
        signedOrderEntity = await connection.manager.save(SignedOrderEntity, signedOrderEntity);
        return signedOrderEntity;
    },
    async findAsync(order: OrderWithoutExchangeAddress): Promise<SignedOrderEntity | undefined> {
        const orderHash = signedOrder.getOrderHash(order);
        const connection = getDBConnection();
        const signedOrderIfExists = await connection.manager.findOne(SignedOrderEntity, orderHash);
        return signedOrderIfExists;
    },
    async findMultipleAsync(orders: OrderWithoutExchangeAddress[]): Promise<SignedOrderEntity[]> {
        const orderHashes = _.map(orders, order => signedOrder.getOrderHash(order));
        const whereClauses = _.map(orderHashes, orderHash => {
            return { orderHashHex: orderHash };
        });
        const connection = getDBConnection();
        const signedOrdersIfExists = await connection.manager.find(SignedOrderEntity, {
            where: whereClauses,
        });
        if (signedOrdersIfExists === undefined) {
            return [];
        }
        return signedOrdersIfExists;
    },
    async isCancelledAsync(order: OrderWithoutExchangeAddress): Promise<boolean> {
        const signedOrderIfExists = await signedOrder.findAsync(order);
        return !_.isUndefined(signedOrderIfExists) && signedOrderIfExists.isCancelled;
    },
    async cancelAsync(order: OrderWithoutExchangeAddress): Promise<void> {
        const orderHash = signedOrder.getOrderHash(order);
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
    getOrderHash(order: OrderWithoutExchangeAddress): string {
        const contractAddresses = getContractAddressesForNetworkOrThrow(NETWORK_ID);
        const orderWithExchangeAddress = {
            ...order,
            exchangeAddress: contractAddresses.exchange,
        };
        const orderHash = orderHashUtils.getOrderHashHex(orderWithExchangeAddress);
        return orderHash;
    },
};
