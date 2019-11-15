import * as bodyParser from 'body-parser';
import * as cors from 'cors';
import * as express from 'express';
import * as asyncHandler from 'express-async-handler';
import * as http from 'http';
import * as HttpStatus from 'http-status-codes';
import * as _ from 'lodash';
import { ConnectionOptions } from 'typeorm';
import * as WebSocket from 'websocket';

import { assertConfigsAreValid } from './assertions';
import { constants } from './constants';
import { hasDBConnection, initDBConnectionAsync } from './db_connection';
import { GeneralErrorCodes, ValidationErrorCodes } from './errors';
import { Handlers } from './handlers';
import { errorHandler } from './middleware/error_handling';
import { urlParamsParsing } from './middleware/url_params_parsing';
import { BroadcastMessage, ChainIdToConnectionStore, ChainIdToProvider, Configs } from './types';
import { utils } from './utils';

const chainIdToConnectionStore: ChainIdToConnectionStore = {};

/**
 * Creates a new express app/server
 * @param provider Ethereum JSON RPC client for interfacing with Ethereum and signing coordinator approvals
 */
export async function getAppAsync(
    chainIdToProvider: ChainIdToProvider,
    configs: Configs,
    dbConfigs?: ConnectionOptions,
): Promise<http.Server> {
    assertConfigsAreValid(configs);
    if (!hasDBConnection()) {
        await initDBConnectionAsync(dbConfigs);
    }

    const handlers = new Handlers(chainIdToProvider, configs, broadcastCallback);
    const app = express();
    app.use(cors());
    app.use(bodyParser.json());
    const supportedChainIds = utils.getSupportedChainIds(configs);
    app.use(urlParamsParsing.bind(undefined, supportedChainIds));

    app.get('/v2/ping', (_, res) => res.send('pong')); // tslint:disable-line:no-shadowed-variable

    /**
     * GET endpoint for requesting current coordination server configuration
     */
    app.get('/v2/configuration', ({}, response: express.Response) => {
        response
            .send({
                expirationDurationSeconds: configs.EXPIRATION_DURATION_SECONDS,
                selectiveDelayMs: configs.SELECTIVE_DELAY_MS,
                supportedChainIds,
            })
            .end();
    });

    /**
     * POST endpoint for requesting signatures for a 0x transaction
     */
    app.post('/v2/request_transaction', asyncHandler(handlers.postRequestTransactionAsync.bind(handlers)));

    /**
     * POST endpoint for checking whether order hashes have been soft-cancelled or not
     */
    app.post('/v2/soft_cancels', asyncHandler(handlers.postSoftCancelsAsync.bind(handlers)));

    app.use(errorHandler);

    /**
     * Create WebSocket server for broadcasting coordinator notifications
     */
    const server = http.createServer(app);
    const wss = new WebSocket.server({
        httpServer: server,
        // Avoid setting autoAcceptConnections to true as it defeats all
        // standard cross-origin procoordinatortion facilities built into the protocol
        // and the browser.
        // Source: https://www.npmjs.com/package/websocket#server-example
        // Also ensures that a request event is emitted by
        // the server whenever a new WebSocket request is made.
        autoAcceptConnections: false,
    });

    /**
     * WebSocket endpoint for subscribing to transaction request notifications
     */
    wss.on('request', async (request: any) => {
        // If the request isn't to the expected endpoint, reject
        if (!_.includes(request.resourceURL.path, '/v2/requests')) {
            request.reject(HttpStatus.NOT_FOUND, 'NOT_FOUND');
            return;
        }
        const chainIdStr = request.resourceURL.query.chainId || constants.DEFAULT_CHAIN_ID.toString();
        const chainId = _.parseInt(chainIdStr);
        if (!_.includes(supportedChainIds, chainId)) {
            const body = {
                code: GeneralErrorCodes.ValidationError,
                reason: 'Validation Failed',
                validationErrors: [
                    {
                        field: 'chainId',
                        code: ValidationErrorCodes.UnsupportedOption,
                        reason: 'Requested chainId not supported by this coordinator',
                    },
                ],
            };
            request.reject(400, JSON.stringify(body));
            return;
        }

        // We do not do origin checks because we want to let anyone subscribe to this endpoint
        // COORDINATOR_OPERATOR: Implement additional credentialling here if desired
        const connection: WebSocket.connection = request.accept(null, request.origin);

        // Note: We don't handle the `message` event because this is a broadcast-only endpoint
        const connectionStoreIfExists = chainIdToConnectionStore[chainId];
        if (connectionStoreIfExists === undefined) {
            // This error should never be hit
            throw new Error(`Attempted to broadcast to unsupported chainId: ${chainId}`);
        }
        connectionStoreIfExists.add(connection);
        connection.on('close', () => {
            connectionStoreIfExists.delete(connection);
        });
    });

    // Initialize the connectionStore mapping for supported chainIds
    supportedChainIds.forEach(chainId => {
        chainIdToConnectionStore[chainId] = new Set<WebSocket.connection>();
    });

    return server;
}

function broadcastCallback(event: BroadcastMessage, chainId: number): void {
    const connectionStoreIfExists = chainIdToConnectionStore[chainId];
    if (connectionStoreIfExists === undefined) {
        // This error should never be hit
        throw new Error(`Attempted to broadcast to unsupported chainId: ${chainId}`);
    }
    connectionStoreIfExists.forEach((connection: WebSocket.connection) => {
        connection.sendUTF(JSON.stringify(event));
    });
}
