import { ConnectionOptions } from 'typeorm';

import { OrderEntity } from './entities/order_entity';
import { TakerAssetFillAmountEntity } from './entities/taker_asset_fill_amount_entity';
import { TransactionEntity } from './entities/transaction_entity';

export const defaultOrmConfig: ConnectionOptions = {
        type: 'sqlite',
        database: 'database.sqlite',
        synchronize: true,
        logging: true,
        entities: [OrderEntity, TakerAssetFillAmountEntity, TransactionEntity],
        cli: {
            entitiesDir: './entities',
        },
    };
