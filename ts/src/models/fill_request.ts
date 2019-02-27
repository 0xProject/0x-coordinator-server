import { OrderWithoutExchangeAddress } from '@0x/types';
import * as _ from 'lodash';

import { getDBConnection } from '../db_connection';
import { FillRequestEntity } from '../entities/fill_request_entity';
import { SignedOrderEntity } from '../entities/signed_order_entity';

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
    ): Promise<FillRequestEntity> {
        let fillRequestEntity = new FillRequestEntity();
        fillRequestEntity.signature = signature;
        fillRequestEntity.expirationTimeSeconds = expiration;
        fillRequestEntity.takerAddress = takerAddress;

        const signedOrderEntities: SignedOrderEntity[] = [];
        for (const order of orders) {
            let signedOrderEntityIfExists = await signedOrder.findAsync(order);
            if (signedOrderEntityIfExists === undefined) {
                signedOrderEntityIfExists = await signedOrder.insertAsync(order);
            }
            signedOrderEntities.push(signedOrderEntityIfExists);
        }

        fillRequestEntity.signedOrders = signedOrderEntities;
        const connection = getDBConnection();
        fillRequestEntity = await connection.manager.save(FillRequestEntity, fillRequestEntity);
        return fillRequestEntity;
    },
};
