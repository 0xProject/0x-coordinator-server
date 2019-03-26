import { orderHashUtils } from '@0x/order-utils';
import { Order } from '@0x/types';
import * as _ from 'lodash';

import { getDBConnection } from '../db_connection';
import { OrderEntity } from '../entities/order_entity';

export const orderModel = {
    async createAsync(order: Order): Promise<OrderEntity> {
        let orderEntity = new OrderEntity();
        const orderHash = orderModel.getHash(order);
        orderEntity.hash = orderHash;
        orderEntity.expirationTimeSeconds = order.expirationTimeSeconds;
        orderEntity.isSoftCancelled = false;

        const connection = getDBConnection();
        orderEntity = await connection.manager.save(OrderEntity, orderEntity);
        return orderEntity;
    },
    async findAsync(order: Order): Promise<OrderEntity | undefined> {
        const orderHash = orderModel.getHash(order);
        const connection = getDBConnection();
        const orderIfExists = await connection.manager.findOne(OrderEntity, orderHash);
        return orderIfExists;
    },
    async isSoftCancelledAsync(order: Order): Promise<boolean> {
        const orderIfExists = await orderModel.findAsync(order);
        return !_.isUndefined(orderIfExists) && orderIfExists.isSoftCancelled;
    },
    async findSoftCancelledOrdersAsync(orders: Order[]): Promise<string[]> {
        const orderHashes = _.map(orders, order => orderModel.getHash(order));
        const connection = getDBConnection();
        const query = connection
            .getRepository(OrderEntity)
            .createQueryBuilder('order')
            .where('hash IN (:...orderHashes)', { orderHashes })
            .andWhere('isSoftCancelled = true');
        const cancelledOrdersIfExist = await query.getMany();
        if (cancelledOrdersIfExist === undefined) {
            return [];
        }
        const cancelledOrderHashes = _.map(cancelledOrdersIfExist, o => o.hash);
        return cancelledOrderHashes;
    },
    async cancelAsync(order: Order): Promise<void> {
        const orderHash = orderModel.getHash(order);
        const connection = getDBConnection();
        const orderIfExists = await connection.manager.findOne(OrderEntity, orderHash);
        let orderEntity: OrderEntity;
        if (orderIfExists === undefined) {
            orderEntity = new OrderEntity();
            orderEntity.hash = orderHash;
            orderEntity.expirationTimeSeconds = order.expirationTimeSeconds;
        } else {
            orderEntity = orderIfExists;
        }
        orderEntity.isSoftCancelled = true;
        await connection.manager.save(OrderEntity, orderEntity);
    },
    getHash(order: Order): string {
        const orderHash = orderHashUtils.getOrderHashHex(order);
        return orderHash;
    },
};
