import { Column, Entity, JoinTable, ManyToMany, PrimaryGeneratedColumn } from 'typeorm';

import { SignedOrderEntity } from './signed_order_entity';

@Entity({ name: 'fill_request' })
export class FillRequestEntity {
    @PrimaryGeneratedColumn()
    public id!: number;

    @ManyToMany(_type => SignedOrderEntity)
    @JoinTable()
    public signedOrders!: SignedOrderEntity[];

    @Column({ name: 'taker_address' })
    public takerAddress!: string;

    @Column({ name: 'signature' })
    public signature!: string;

    @Column({ name: 'expiration_time_seconds' })
    public expirationTimeSeconds!: number;
}
