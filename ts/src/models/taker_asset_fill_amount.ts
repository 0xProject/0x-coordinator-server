import { BigNumber } from '@0x/utils';

import { getDBConnection } from '../db_connection';
import { SignedOrderEntity } from '../entities/signed_order_entity';
import { TakerAssetFillAmountEntity } from '../entities/taker_asset_fill_amount_entity';

export const takerAssetFillAmount = {
    async createAsync(
        signedOrderEntity: SignedOrderEntity,
        takerAddress: string,
        fillAmount: BigNumber,
    ): Promise<TakerAssetFillAmountEntity> {
        let takerAssetFillAmountEntity = new TakerAssetFillAmountEntity();
        takerAssetFillAmountEntity.takerAssetFillAmount = fillAmount;
        takerAssetFillAmountEntity.takerAddress = takerAddress;
        takerAssetFillAmountEntity.signedOrder = signedOrderEntity;

        const connection = getDBConnection();
        takerAssetFillAmountEntity = await connection.manager.save(
            TakerAssetFillAmountEntity,
            takerAssetFillAmountEntity,
        );
        return takerAssetFillAmountEntity;
    },
};
