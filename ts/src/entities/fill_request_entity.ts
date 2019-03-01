import { Column, Entity, JoinTable, ManyToMany, PrimaryGeneratedColumn } from 'typeorm';

import { SignedOrderEntity } from './signed_order_entity';

@Entity({ name: 'fill_request' })
export class FillRequestEntity {
    @PrimaryGeneratedColumn()
    public id!: number;

    @ManyToMany(_type => SignedOrderEntity)
    @JoinTable()
    public signedOrders!: SignedOrderEntity[];

    @Column()
    public takerAddress!: string;

    @Column()
    public signature!: string;

    @Column()
    public expirationTimeSeconds!: number;
}
