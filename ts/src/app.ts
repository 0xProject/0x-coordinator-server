import * as bodyParser from 'body-parser';
import * as cors from 'cors';
import { Provider } from 'ethereum-types';
import * as express from 'express';
import * as asyncHandler from 'express-async-handler';

import { initDBConnectionAsync } from './db_connection';
import { Handlers } from './handlers';
import { errorHandler } from './middleware/error_handling';

export async function getAppAsync(provider: Provider): Promise<any> {
    await initDBConnectionAsync();

    const handlers = new Handlers(provider);
    const app = express();
    app.use(cors());
    app.use(bodyParser.json());

    /**
     * POST endpoint for requesting signatures for a 0x transaction
     */
    app.post('/v1/request_transaction', asyncHandler(handlers.postRequestTransactionAsync.bind(handlers)));

    app.use(errorHandler);

    return app;
}
