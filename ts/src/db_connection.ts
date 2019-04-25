import * as _ from 'lodash';
import { Connection, ConnectionOptions, createConnection } from 'typeorm';

import { OrderEntity } from './entities/order_entity';
import { TakerAssetFillAmountEntity } from './entities/taker_asset_fill_amount_entity';
import { TransactionEntity } from './entities/transaction_entity';

let connectionIfExists: Connection | undefined;

/**
 * Checks if a connection already exists
 * @return Whether a connection exists
 */
export function hasDBConnection(): boolean {
    return !_.isUndefined(connectionIfExists);
}

/**
 * Returns the DB connnection
 */
export function getDBConnection(): Connection {
    if (_.isUndefined(connectionIfExists)) {
        throw new Error('DB connection not initialized');
    }
    return connectionIfExists;
}

/**
 * Creates the DB connnection to use in an app
 */
export async function initDBConnectionAsync(options?: ConnectionOptions): Promise<void> {
    if (!_.isUndefined(connectionIfExists)) {
        throw new Error('DB connection already exists');
    }
    let connOptions = options;
    if (connOptions === undefined) {
        connOptions = {
            type: 'sqlite',
            database: 'database.sqlite',
            synchronize: true,
            logging: true,
            entities: [OrderEntity, TakerAssetFillAmountEntity, TransactionEntity],
            cli: {
                entitiesDir: './entities',
            },
        };
    }
    connectionIfExists = await createConnection(connOptions);
}
