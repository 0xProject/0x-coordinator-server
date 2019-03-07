import { getContractAddressesForNetworkOrThrow } from '@0x/contract-addresses';
import { orderHashUtils } from '@0x/order-utils';
import { OrderWithoutExchangeAddress } from '@0x/types';
import * as _ from 'lodash';

import { NETWORK_ID } from '../config.js';
import { getDBConnection } from '../db_connection';
import { OrderEntity } from '../entities/order_entity';

export const orderModel = {
    async createAsync(order: OrderWithoutExchangeAddress): Promise<OrderEntity> {
        let orderEntity = new OrderEntity();
        const orderHash = orderModel.getHash(order);
        orderEntity.hash = orderHash;
        orderEntity.isCancelled = false;

        const connection = getDBConnection();
        orderEntity = await connection.manager.save(OrderEntity, orderEntity);
        return orderEntity;
    },
    async findAsync(order: OrderWithoutExchangeAddress): Promise<OrderEntity | undefined> {
        const orderHash = orderModel.getHash(order);
        const connection = getDBConnection();
        const orderIfExists = await connection.manager.findOne(OrderEntity, orderHash);
        return orderIfExists;
    },
    async isCancelledAsync(order: OrderWithoutExchangeAddress): Promise<boolean> {
        const orderIfExists = await orderModel.findAsync(order);
        return !_.isUndefined(orderIfExists) && orderIfExists.isCancelled;
    },
    async cancelAsync(order: OrderWithoutExchangeAddress): Promise<void> {
        const orderHash = orderModel.getHash(order);
        const connection = getDBConnection();
        const orderIfExists = await connection.manager.findOne(OrderEntity, orderHash);
        let orderEntity: OrderEntity;
        if (orderIfExists === undefined) {
            orderEntity = new OrderEntity();
            orderEntity.hash = orderHash;
            orderEntity.isCancelled = true;
        } else {
            orderEntity = orderIfExists;
            orderEntity.isCancelled = true;
        }
        await connection.manager.save(OrderEntity, orderEntity);
    },
    getHash(order: OrderWithoutExchangeAddress): string {
        const contractAddresses = getContractAddressesForNetworkOrThrow(NETWORK_ID);
        const orderWithExchangeAddress = {
            ...order,
            exchangeAddress: contractAddresses.exchange,
        };
        const orderHash = orderHashUtils.getOrderHashHex(orderWithExchangeAddress);
        return orderHash;
    },
};
