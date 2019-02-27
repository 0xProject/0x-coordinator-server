import * as bodyParser from 'body-parser';
import * as cors from 'cors';
import { Provider } from 'ethereum-types';
import * as express from 'express';
import * as asyncHandler from 'express-async-handler';
import * as http from 'http';
import * as WebSocket from 'websocket';

import { hasDBConnection, initDBConnectionAsync } from './db_connection';
import { Handlers } from './handlers';
import { errorHandler } from './middleware/error_handling';
import { BroadcastMessage } from './types';

const connectionStore: Set<WebSocket.connection> = new Set();

export async function getAppAsync(provider: Provider): Promise<any> {
    if (!hasDBConnection()) {
        await initDBConnectionAsync();
    }

    const handlers = new Handlers(provider, (event: BroadcastMessage) => {
        connectionStore.forEach((connection: WebSocket.connection) => {
            connection.sendUTF(JSON.stringify(event));
        });
    });
    const app = express();
    app.use(cors());
    app.use(bodyParser.json());

    /**
     * POST endpoint for requesting signatures for a 0x transaction
     */
    app.post('/v1/request_transaction', asyncHandler(handlers.postRequestTransactionAsync.bind(handlers)));

    app.use(errorHandler);

    const server = http.createServer(app);
    const wss = new WebSocket.server({
        httpServer: server,
        // Avoid setting autoAcceptConnections to true as it defeats all
        // standard cross-origin protection facilities built into the protocol
        // and the browser.
        // Source: https://www.npmjs.com/package/websocket#server-example
        // Also ensures that a request event is emitted by
        // the server whenever a new WebSocket request is made.
        autoAcceptConnections: false,
    });

    /**
     * WebSocket endpoint for subscribing to fill request notifications
     */
    wss.on('request', async (request: any) => {
        // If the request isn't to `/v1/requests`, reject
        if (request.resourceURL.path !== '/v1/requests') {
            request.reject(400, 'INCORRECT_PATH');
            return;
        }

        // We do not do origin checks because we want to let anyone subscribe to this endpoint
        // TODO: Implement additional credentialling here if wanted
        const connection: WebSocket.connection = request.accept(null, request.origin);

        // Note: We don't handle the `message` event because this is a listen-only endpoint
        connection.on('close', () => {
            connectionStore.delete(connection);
        });
        connectionStore.add(connection);
    });

    return server;
}
