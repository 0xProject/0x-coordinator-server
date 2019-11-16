import * as express from 'express';
import * as _ from 'lodash';

import { constants } from '../constants';
import { ValidationError, ValidationErrorCodes } from '../errors';

/**
 * Parses URL params and stores them on the request object
 */
export function urlParamsParsing(
    supportedChainIds: number[],
    req: express.Request,
    _res: express.Response,
    next: express.NextFunction,
): void {
    const chainId = parseChainId(supportedChainIds, req.query.chainId);
    // HACK(leo): This is the recommended way to pass data from middlewares on. It's not beautiful nor fully type-safe.
    req.chainId = chainId;
    next();
}

function parseChainId(supportedChainIds: number[], chainIdStrIfExists?: string): number {
    if (chainIdStrIfExists === undefined) {
        return constants.DEFAULT_CHAIN_ID;
    } else {
        const chainId = _.parseInt(chainIdStrIfExists);
        if (!_.includes(supportedChainIds, chainId)) {
            const validationErrorItem = {
                field: 'chainId',
                code: ValidationErrorCodes.UnsupportedOption,
                reason: 'Requested chainId not supported by this coordinator',
            };
            throw new ValidationError([validationErrorItem]);
        }
        return chainId;
    }
}
