import { Column, Entity, PrimaryColumn } from 'typeorm';

@Entity({ name: 'signed_order' })
export class SignedOrderEntity {
    @PrimaryColumn({ name: 'order_hash_hex' })
    public orderHashHex!: string;

    @Column({ name: 'is_cancelled' })
    public isCancelled!: boolean;
}
