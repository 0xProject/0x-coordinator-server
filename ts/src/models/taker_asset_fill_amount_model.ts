import { Order } from '@0x/types';
import { BigNumber } from '@0x/utils';
import * as _ from 'lodash';

import { getDBConnection } from '../db_connection';
import { OrderEntity } from '../entities/order_entity';
import { TakerAssetFillAmountEntity } from '../entities/taker_asset_fill_amount_entity';
import { OrderHashToFillAmount } from '../types';
import { utils } from '../utils';

import { orderModel } from './order_model';

export const takerAssetFillAmountModel = {
    async createAsync(orderEntity: OrderEntity, fillAmount: BigNumber, expirationTimeSeconds: number): Promise<TakerAssetFillAmountEntity> {
        let takerAssetFillAmountEntity = new TakerAssetFillAmountEntity();
        takerAssetFillAmountEntity.takerAssetFillAmount = fillAmount;
        takerAssetFillAmountEntity.orderHash = orderEntity.hash;
        takerAssetFillAmountEntity.expirationTimeSeconds = expirationTimeSeconds;

        const connection = getDBConnection();
        takerAssetFillAmountEntity = await connection.manager.save(
            TakerAssetFillAmountEntity,
            takerAssetFillAmountEntity,
        );
        return takerAssetFillAmountEntity;
    },
    async findByOrdersAsync(
        orders: Order[],
        opts?: {
            isExpired?: boolean;
        },
    ): Promise<TakerAssetFillAmountEntity[]> {
        const connection = getDBConnection();
        const orderHashes = _.map(orders, order => orderModel.getHash(order));
        let query = connection
            .getRepository(TakerAssetFillAmountEntity)
            .createQueryBuilder('fill_amount')
            .where('fill_amount.orderHash IN (:...orderHashes)', { orderHashes });
        if (opts !== undefined && !opts.isExpired) {
            const currentExpiration = utils.getCurrentTimestampSeconds();
            query = query.andWhere('fill_amount.expirationTimeSeconds > :currentExpiration', {
                currentExpiration,
            });
        }

        const transactionsIfExists = await query.getMany();
        if (transactionsIfExists === undefined) {
            return [];
        }
        return transactionsIfExists;
    },
    async getOrderHashToFillAmountReservedAsync(
        orders: Order[],
    ): Promise<OrderHashToFillAmount> {
        const orderFillAmounts = await takerAssetFillAmountModel.findByOrdersAsync(orders, { isExpired: false });
        const orderHashToFillAmount: OrderHashToFillAmount = {};
        for (const orderFillAmount of orderFillAmounts) {
            const existingFillAmountIfExists = orderHashToFillAmount[orderFillAmount.orderHash];
            orderHashToFillAmount[orderFillAmount.orderHash] =
                existingFillAmountIfExists === undefined
                    ? orderFillAmount.takerAssetFillAmount
                    : existingFillAmountIfExists.plus(orderFillAmount.takerAssetFillAmount);
        }
        return orderHashToFillAmount;
    },
};
