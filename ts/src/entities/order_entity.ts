import { Column, Entity, PrimaryColumn } from 'typeorm';

@Entity({ name: 'order' })
export class OrderEntity {
    @PrimaryColumn()
    public hash!: string;

    @Column()
    public isCancelled!: boolean;
}
