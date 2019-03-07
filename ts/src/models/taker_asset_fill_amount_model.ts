import { BigNumber } from '@0x/utils';

import { getDBConnection } from '../db_connection';
import { OrderEntity } from '../entities/order_entity';
import { TakerAssetFillAmountEntity } from '../entities/taker_asset_fill_amount_entity';

export const takerAssetFillAmountModel = {
    async createAsync(orderEntity: OrderEntity, fillAmount: BigNumber): Promise<TakerAssetFillAmountEntity> {
        let takerAssetFillAmountEntity = new TakerAssetFillAmountEntity();
        takerAssetFillAmountEntity.takerAssetFillAmount = fillAmount;
        takerAssetFillAmountEntity.orderHash = orderEntity.hash;

        const connection = getDBConnection();
        takerAssetFillAmountEntity = await connection.manager.save(
            TakerAssetFillAmountEntity,
            takerAssetFillAmountEntity,
        );
        return takerAssetFillAmountEntity;
    },
};
