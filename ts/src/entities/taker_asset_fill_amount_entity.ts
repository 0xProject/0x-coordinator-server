import { BigNumber } from '@0x/utils';
import { Column, Entity, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';

import { bigNumberTransformer } from '../transformers/big_number';

import { SignedOrderEntity } from './signed_order_entity';

@Entity()
export class TakerAssetFillAmountEntity {
    @PrimaryGeneratedColumn()
    public id!: number;

    @Column()
    public takerAddress!: string;

    @Column({ type: 'numeric', transformer: bigNumberTransformer })
    public takerAssetFillAmount!: BigNumber;

    @ManyToOne(_type => SignedOrderEntity, signedOrderEntity => signedOrderEntity.takerAssetFillAmounts)
    public signedOrder!: SignedOrderEntity;
}
