import { Column, Entity, OneToMany, PrimaryColumn } from 'typeorm';

import { TakerAssetFillAmountEntity } from './taker_asset_fill_amount_entity';

@Entity({ name: 'signed_order' })
export class SignedOrderEntity {
    @PrimaryColumn()
    public orderHashHex!: string;

    @Column()
    public isCancelled!: boolean;

    @OneToMany(
        _type => TakerAssetFillAmountEntity,
        takerAssetFillAmountEntity => takerAssetFillAmountEntity.signedOrder,
        { eager: true },
    )
    public takerAssetFillAmounts!: TakerAssetFillAmountEntity[];
}
