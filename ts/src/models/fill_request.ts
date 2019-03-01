import { OrderWithoutExchangeAddress } from '@0x/types';
import { BigNumber } from '@0x/utils';
import * as _ from 'lodash';

import { getDBConnection } from '../db_connection';
import { FillRequestEntity } from '../entities/fill_request_entity';
import { SignedOrderEntity } from '../entities/signed_order_entity';
import { takerAssetFillAmount } from '../models/taker_asset_fill_amount';

import { signedOrder } from './signed_order';

export const fillRequest = {
    async findAsync(takerAddress: string, signature: string): Promise<FillRequestEntity | undefined> {
        const connection = getDBConnection();
        const fillRequestIfExists = await connection.manager.findOne(FillRequestEntity, {
            takerAddress,
            signature,
        });
        return fillRequestIfExists;
    },
    async createAsync(
        signature: string,
        expiration: number,
        takerAddress: string,
        orders: OrderWithoutExchangeAddress[],
        takerAssetFillAmounts: BigNumber[],
    ): Promise<FillRequestEntity> {
        let fillRequestEntity = new FillRequestEntity();
        fillRequestEntity.signature = signature;
        fillRequestEntity.expirationTimeSeconds = expiration;
        fillRequestEntity.takerAddress = takerAddress;

        const signedOrderEntities: SignedOrderEntity[] = [];
        for (let i = 0; i < orders.length; i++) {
            const order = orders[i];
            let signedOrderEntityIfExists = await signedOrder.findAsync(order);
            if (signedOrderEntityIfExists === undefined) {
                signedOrderEntityIfExists = await signedOrder.createAsync(order);
            }
            const fillAmount = takerAssetFillAmounts[i];
            takerAssetFillAmount.createAsync(signedOrderEntityIfExists, takerAddress, fillAmount);
            signedOrderEntities.push(signedOrderEntityIfExists);
        }

        fillRequestEntity.signedOrders = signedOrderEntities;
        const connection = getDBConnection();
        fillRequestEntity = await connection.manager.save(FillRequestEntity, fillRequestEntity);
        return fillRequestEntity;
    },
};
