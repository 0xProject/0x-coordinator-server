import * as express from 'express';

/**
 * Catches errors thrown by our code and serialies them
 */
export function errorHandler(
    err: Error,
    _req: express.Request,
    res: express.Response,
    next: express.NextFunction,
): void {
    // If you call next() with an error after you have started writing the response
    // (for example, if you encounter an error while streaming the response to the client)
    // the Express default error handler closes the connection and fails the request.
    if (res.headersSent) {
        return next(err);
    }

    // TODO: Custom error handling logic goes here.

    return next(err);
}
