import { Order } from '@0x/types';
import { BigNumber } from '@0x/utils';
import * as _ from 'lodash';

import { getDBConnection } from '../db_connection';
import { OrderEntity } from '../entities/order_entity';
import { TakerAssetFillAmountEntity } from '../entities/taker_asset_fill_amount_entity';
import { TransactionEntity } from '../entities/transaction_entity';
import { takerAssetFillAmountModel } from '../models/taker_asset_fill_amount_model';
import { OrderHashToFillAmount, OutstandingFillSignatures } from '../types';
import { utils } from '../utils';

import { orderModel } from './order_model';

export const transactionModel = {
    async findByHashAsync(transactionHash: string): Promise<TransactionEntity | undefined> {
        const connection = getDBConnection();
        const transactionIfExists = await connection.manager.findOne(TransactionEntity, {
            hash: transactionHash,
        });
        return transactionIfExists;
    },
    async findAsync(takerAddress: string, approvalSignatures: string): Promise<TransactionEntity | undefined> {
        const connection = getDBConnection();
        const transactionIfExists = await connection.manager.findOne(TransactionEntity, {
            takerAddress,
            approvalSignatures,
        });
        return transactionIfExists;
    },
    async findByOrdersAsync(
        orders: Order[],
        opts?: {
            takerAddress?: string;
            isExpired?: boolean;
            txOrigin?: string;
            takerContractWhitelist?: string[];
        },
    ): Promise<TransactionEntity[]> {
        const connection = getDBConnection();
        const orderHashes = _.map(orders, order => orderModel.getHash(order));
        let query = connection
            .getRepository(TransactionEntity)
            .createQueryBuilder('transaction')
            .leftJoinAndSelect('transaction.orders', 'order')
            .leftJoinAndSelect('transaction.takerAssetFillAmounts', 'takerAssetFillAmount')
            .where('order.hash IN (:...orderHashes)', { orderHashes });
        if (opts !== undefined && opts.takerAddress !== undefined) {
            if (
                opts.takerContractWhitelist !== undefined &&
                opts.takerContractWhitelist.includes(opts.takerAddress.toLowerCase())
            ) {
                if (opts.txOrigin === undefined) {
                    throw new Error(`takerAddress ${opts.takerAddress} is whitelisted but no txOrigin was given`);
                }
                query = query.andWhere('transaction.txOrigin = :txOrigin', { txOrigin: opts.txOrigin });
            } else {
                query = query.andWhere('transaction.takerAddress = :takerAddress', {
                    takerAddress: opts.takerAddress,
                });
            }
        } else if (opts !== undefined && opts.txOrigin !== undefined) {
            query = query.andWhere('transaction.txOrigin = :txOrigin', { txOrigin: opts.txOrigin });
        }
        if (opts !== undefined && !opts.isExpired) {
            const currentExpiration = utils.getCurrentTimestampSeconds();
            query = query.andWhere('transaction.expirationTimeSeconds > :currentExpiration', {
                currentExpiration,
            });
        }

        const transactionsIfExists = await query.getMany();
        if (transactionsIfExists === undefined) {
            return [];
        }
        return transactionsIfExists;
    },
    async createAsync(
        transactionHash: string,
        txOrigin: string,
        approvalSignatures: string[],
        expirationTimeSeconds: number,
        takerAddress: string,
        orders: Order[],
        takerAssetFillAmounts: BigNumber[],
    ): Promise<TransactionEntity> {
        let transactionEntity = new TransactionEntity();
        // We store the approvalSignatures as a JSON array of signatures since we don't expect to ever query by
        // a specific signature
        transactionEntity.hash = transactionHash;
        transactionEntity.txOrigin = txOrigin;
        transactionEntity.approvalSignatures = JSON.stringify(approvalSignatures);
        transactionEntity.expirationTimeSeconds = expirationTimeSeconds;
        transactionEntity.takerAddress = takerAddress;

        const orderEntities: OrderEntity[] = [];
        const takerAssetFillAmountEntities: TakerAssetFillAmountEntity[] = [];
        for (let i = 0; i < orders.length; i++) {
            const order = orders[i];
            let orderEntityIfExists = await orderModel.findAsync(order);
            if (orderEntityIfExists === undefined) {
                orderEntityIfExists = await orderModel.createAsync(order);
            }
            orderEntities.push(orderEntityIfExists);
            const fillAmount = takerAssetFillAmounts[i];
            const takerAssetFillAmountEntity = await takerAssetFillAmountModel.createAsync(
                orderEntityIfExists,
                fillAmount,
            );
            takerAssetFillAmountEntities.push(takerAssetFillAmountEntity);
        }

        transactionEntity.orders = orderEntities;
        transactionEntity.takerAssetFillAmounts = takerAssetFillAmountEntities;
        const connection = getDBConnection();
        transactionEntity = await connection.manager.save(TransactionEntity, transactionEntity);
        return transactionEntity;
    },
    async getOrderHashToFillAmountRequestedAsync(
        orders: Order[],
        takerAddress: string,
        txOrigin: string,
        takerContractWhitelist?: string[],
    ): Promise<OrderHashToFillAmount> {
        const orderHashes = _.map(orders, o => orderModel.getHash(o));
        const transactions = await transactionModel.findByOrdersAsync(orders, {
            takerAddress,
            txOrigin,
            takerContractWhitelist,
        });
        const orderHashToFillAmount: OrderHashToFillAmount = {};
        for (const transaction of transactions) {
            const relevantOrders = _.filter(transaction.orders, o => _.includes(orderHashes, o.hash));
            for (const relevantOrder of relevantOrders) {
                const fillAmountEntity = _.find(
                    transaction.takerAssetFillAmounts,
                    a => a.orderHash === relevantOrder.hash,
                );
                if (fillAmountEntity === undefined) {
                    // We don't expect this condition to ever hit
                    throw new Error(`There should always be a fillAmount for every order.`);
                }
                const existingFillAmountIfExists = orderHashToFillAmount[relevantOrder.hash];
                orderHashToFillAmount[relevantOrder.hash] =
                    existingFillAmountIfExists === undefined
                        ? fillAmountEntity.takerAssetFillAmount
                        : existingFillAmountIfExists.plus(fillAmountEntity.takerAssetFillAmount);
            }
        }
        return orderHashToFillAmount;
    },
    async getOutstandingFillSignaturessByOrdersAsync(coordinatorOrders: Order[]): Promise<OutstandingFillSignatures[]> {
        const coordinatorOrderHashes = _.map(coordinatorOrders, o => orderModel.getHash(o));
        const transactions = await transactionModel.findByOrdersAsync(coordinatorOrders, { isExpired: false });
        const outstandingFillSignatures: OutstandingFillSignatures[] = [];
        _.each(transactions, transaction => {
            _.each(transaction.orders, order => {
                if (_.includes(coordinatorOrderHashes, order.hash)) {
                    const fillAmount = _.find(transaction.takerAssetFillAmounts, { orderHash: order.hash });
                    if (fillAmount === undefined) {
                        throw new Error(
                            `Unexpected failure. Found order in transaction without corresponding fillAmount: ${
                                order.hash
                            }`,
                        );
                    }
                    outstandingFillSignatures.push({
                        orderHash: order.hash,
                        approvalSignatures: JSON.parse(transaction.approvalSignatures),
                        expirationTimeSeconds: transaction.expirationTimeSeconds,
                        takerAssetFillAmount: fillAmount.takerAssetFillAmount,
                    });
                }
            });
        });
        return outstandingFillSignatures;
    },
};
