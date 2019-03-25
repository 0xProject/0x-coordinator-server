import { Column, Entity, JoinTable, ManyToMany, OneToMany, PrimaryColumn } from 'typeorm';

import { OrderEntity } from './order_entity';
import { TakerAssetFillAmountEntity } from './taker_asset_fill_amount_entity';

@Entity({ name: 'transaction' })
export class TransactionEntity {
    @PrimaryColumn()
    public hash!: string;

    @ManyToMany(_type => OrderEntity)
    @JoinTable()
    public orders!: OrderEntity[];

    @OneToMany(
        _type => TakerAssetFillAmountEntity,
        takerAssetFillAmountEntity => takerAssetFillAmountEntity.transaction,
        {
            eager: true,
        },
    )
    public takerAssetFillAmounts!: TakerAssetFillAmountEntity[];

    @Column()
    public takerAddress!: string;

    @Column()
    public txOrigin!: string;

    @Column()
    public signatures!: string; // JSON encoded string

    @Column()
    public expirationTimeSeconds!: number;
}
