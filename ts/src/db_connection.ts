import * as _ from 'lodash';
import { Connection, ConnectionOptions, createConnection } from 'typeorm';

import { defaultOrmConfig } from './default_ormconfig';

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
    const connOptions = options === undefined ? defaultOrmConfig : options;
    connectionIfExists = await createConnection(connOptions);
}
