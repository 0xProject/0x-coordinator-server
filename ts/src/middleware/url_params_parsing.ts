import * as express from 'express';
import * as _ from 'lodash';

import { ValidationError } from '../errors';

const DEFAULT_NETWORK_ID = 1;

/**
 * Parses URL params and stores them on the request object
 */
export function urlParamsParsing(
    supportedNetworkIds: number[],
    req: express.Request,
    _res: express.Response,
    next: express.NextFunction,
): void {
    const networkId = parseNetworkId(supportedNetworkIds, req.query.networkId);
    // HACK: This is the recommended way to pass data from middlewares on. It's not beautiful nor fully type-safe.
    req.networkId = networkId;
    next();
}

function parseNetworkId(supportedNetworkIds: number[], networkIdStrIfExists?: string): number {
    if (_.isUndefined(networkIdStrIfExists)) {
        return DEFAULT_NETWORK_ID;
    } else {
        const networkId = _.parseInt(networkIdStrIfExists);
        if (!_.includes(supportedNetworkIds, networkId)) {
            const validationErrorItem = {
                field: 'networkId',
                code: 1004,
                reason: `Unsupported Network ID: ${networkIdStrIfExists}`,
            };
            throw new ValidationError([validationErrorItem]);
        }
        return networkId;
    }
}
