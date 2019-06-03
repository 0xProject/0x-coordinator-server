import { BigNumber } from '@0x/utils';
import { Column, Entity, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';

import { TransactionEntity } from '../entities/transaction_entity';
import { bigNumberTransformer } from '../transformers/big_number';

@Entity()
export class TakerAssetFillAmountEntity {
    @PrimaryGeneratedColumn()
    public id!: number;

    @Column({ type: 'decimal', precision: 30, scale: 0, transformer: bigNumberTransformer })
    public takerAssetFillAmount!: BigNumber;

    @Column()
    public orderHash!: string;

    @Column()
    public expirationTimeSeconds!: number;

    @ManyToOne(_type => TransactionEntity, transaction => transaction.takerAssetFillAmounts)
    public transaction!: TransactionEntity;
}
