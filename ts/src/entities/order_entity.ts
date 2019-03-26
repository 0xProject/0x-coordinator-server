import { BigNumber } from '@0x/utils';
import { Column, Entity, PrimaryColumn } from 'typeorm';

import { bigNumberTransformer } from '../transformers/big_number';

@Entity({ name: 'order' })
export class OrderEntity {
    @PrimaryColumn()
    public hash!: string;

    @Column({ type: 'numeric', transformer: bigNumberTransformer })
    public expirationTimeSeconds!: BigNumber;

    @Column()
    public isSoftCancelled!: boolean;
}
