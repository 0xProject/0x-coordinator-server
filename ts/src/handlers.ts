import { ContractWrappers, DecodedCalldata, signatureUtils, transactionHashUtils } from '0x.js';
import { getContractAddressesForNetworkOrThrow } from '@0x/contract-addresses';
import { eip712Utils } from '@0x/order-utils';
import { Order, SignedZeroExTransaction } from '@0x/types';
import { signTypedDataUtils } from '@0x/utils';
import { Provider } from 'ethereum-types';
import * as express from 'express';
import * as HttpStatus from 'http-status-codes';
import * as _ from 'lodash';

import { FEE_RECIPIENT, NETWORK_ID } from './config.js';
import { fillRequest } from './models/fill_request.js';
import { signedOrder } from './models/signed_order';
import * as requestTransactionSchema from './schemas/request_transaction_schema.json';
import { RequestTransactionErrors, RequestTransactionResponse, Response, TECApproval } from './types';
import { utils } from './utils';

const EXPIRATION_DURATION = 60 * 1; // 1 min

export class Handlers {
    private readonly _provider: Provider;
    private readonly _contractWrappers: ContractWrappers;
    private static _getOrdersFromDecodedCallData(decodedCalldata: DecodedCalldata): Order[] {
        switch (decodedCalldata.functionName) {
            case 'fillOrder':
            case 'fillOrKillOrder':
            case 'fillOrderNoThrow':
            case 'cancelOrder':
                return [decodedCalldata.functionArguments.order];

            case 'batchFillOrders':
            case 'batchFillOrKillOrders':
            case 'batchFillOrdersNoThrow':
            case 'marketSellOrders':
            case 'marketSellOrdersNoThrow':
            case 'marketBuyOrders':
            case 'marketBuyOrdersNoThrow':
            case 'batchCancelOrders':
                return decodedCalldata.functionArguments.orders;

            case 'matchOrders':
                // HACK(fabio): The ABI decoder we use cannot distinguish between the
                // matchOrders function in Exchange and the identically named function
                // in our Auction contract, and it always decodes them using the Auction
                // contract param names. We rename them to `leftOrder` and `rightOrder` here.
                const leftOrder = decodedCalldata.functionArguments.buyOrder;
                const rightOrder = decodedCalldata.functionArguments.sellOrder;
                return [leftOrder, rightOrder];

            default:
                throw new Error(RequestTransactionErrors.InvalidFunctionCall);
        }
    }
    private static async _handleCancelsAsync(
        orders: Order[],
        signedTransaction: SignedZeroExTransaction,
    ): Promise<Response> {
        for (const order of orders) {
            if (!utils.isTECFeeRecipient(order.feeRecipientAddress)) {
                continue;
            }
            if (signedTransaction.signerAddress !== order.makerAddress) {
                return {
                    status: HttpStatus.BAD_REQUEST,
                    body: RequestTransactionErrors.CancellationTransactionNotSignedByMaker,
                };
            }
            await signedOrder.cancelAsync(order);
        }
        return {
            status: HttpStatus.OK,
        };
    }
    constructor(provider: Provider) {
        this._provider = provider;
        this._contractWrappers = new ContractWrappers(provider, {
            networkId: NETWORK_ID,
        });
    }
    public async postRequestTransactionAsync(req: express.Request, res: express.Response): Promise<void> {
        // 1. Validate request schema
        utils.validateSchema(req.body, requestTransactionSchema);

        // 2. Decode the supplied transaction data
        const signedTransaction = req.body.signedTransaction;
        let decodedCalldata: DecodedCalldata;
        try {
            decodedCalldata = this._contractWrappers.getAbiDecoder().decodeCalldataOrThrow(signedTransaction.data);
        } catch (err) {
            res.status(HttpStatus.BAD_REQUEST).send(RequestTransactionErrors.DecodingTransactionFailed);
            return;
        }

        // 3. Check if at least one order in calldata has the TEC's feeRecipientAddress
        let orders: Order[] = [];
        try {
            orders = Handlers._getOrdersFromDecodedCallData(decodedCalldata);
        } catch (err) {
            res.status(HttpStatus.BAD_REQUEST).send(err.message);
            return;
        }
        const hasTECOrders = _.some(orders, order => utils.isTECFeeRecipient(order.feeRecipientAddress));
        if (!hasTECOrders) {
            res.status(HttpStatus.BAD_REQUEST).send(RequestTransactionErrors.TECFeeRecipientNotFound);
            return;
        }

        // 4. Validate the 0x transaction signature
        const transactionHash = transactionHashUtils.getTransactionHashHex(signedTransaction);
        // TODO(fabio): Do we want to limit orders to using ECSignatures?
        // Answer: YES. Refactor this. Without this, it's harder to know who the "taker" is...
        const isValidSignature = await signatureUtils.isValidSignatureAsync(
            this._provider,
            transactionHash,
            signedTransaction.signature,
            signedTransaction.signerAddress,
        );
        if (!isValidSignature) {
            res.status(HttpStatus.BAD_REQUEST).send(RequestTransactionErrors.InvalidTransactionSignature);
            return;
        }

        // 5. Handle the request
        switch (decodedCalldata.functionName) {
            case 'fillOrder':
            case 'fillOrKillOrder':
            case 'fillOrderNoThrow':
            case 'batchFillOrders':
            case 'batchFillOrKillOrders':
            case 'batchFillOrdersNoThrow':
            case 'marketSellOrders':
            case 'marketSellOrdersNoThrow':
            case 'marketBuyOrders':
            case 'marketBuyOrdersNoThrow':
            case 'matchOrders': {
                const response = await this._handleFillsAsync(orders, signedTransaction);
                res.status(response.status).send(response.body);
                return;
            }

            case 'cancelOrder': {
                const order = orders[0];
                if (signedTransaction.signerAddress !== order.makerAddress) {
                    res.status(HttpStatus.BAD_REQUEST).send(
                        RequestTransactionErrors.CancellationTransactionNotSignedByMaker,
                    );
                    return;
                }
                await signedOrder.cancelAsync(order);
                res.status(HttpStatus.OK).send();
                return;
            }

            case `batchCancelOrders`: {
                const response = await Handlers._handleCancelsAsync(orders, signedTransaction);
                res.status(response.status).send(response.body);
                return;
            }

            default:
                res.status(HttpStatus.BAD_REQUEST).send(RequestTransactionErrors.InvalidFunctionCall);
                return;
        }
    }
    private async _handleFillsAsync(orders: Order[], signedTransaction: SignedZeroExTransaction): Promise<Response> {
        for (const order of orders) {
            if (!utils.isTECFeeRecipient(order.feeRecipientAddress)) {
                continue;
            }
            // If cancelled, reject the request
            const isCancelled = await signedOrder.isCancelledAsync(order);
            if (isCancelled) {
                return {
                    status: HttpStatus.BAD_REQUEST,
                    body: RequestTransactionErrors.OrderCancelled,
                };
            }
        }
        const response = await this._generateAndStoreSignatureAsync(signedTransaction, orders);
        return {
            status: HttpStatus.OK,
            body: response,
        };
    }
    private async _generateAndStoreSignatureAsync(
        signedTransaction: SignedZeroExTransaction,
        orders: Order[],
    ): Promise<RequestTransactionResponse> {
        // generate signature & expiry and add to DB
        const approvalExpirationTimeSeconds = utils.getCurrentTimestampSeconds() + EXPIRATION_DURATION;
        const transactionHash = transactionHashUtils.getTransactionHashHex(signedTransaction);
        const tecApproval: TECApproval = {
            transactionHash,
            transactionSignature: signedTransaction.signature,
            approvalExpirationTimeSeconds,
        };
        const TEC_APPROVAL_SCHEMA = {
            name: 'TECApproval',
            parameters: [
                { name: 'transactionHash', type: 'bytes32' },
                { name: 'transactionSignature', type: 'bytes' },
                { name: 'approvalExpirationTimeSeconds', type: 'uint256' },
            ],
        };
        const normalizedTecApproval = _.mapValues(tecApproval, value => {
            return !_.isString(value) ? value.toString() : value;
        });
        // HACK(fabio): Hard-code fake TEC address until we've deployed the contract and added
        // the address to `@0x/contract-addresses`
        const contractAddresses = getContractAddressesForNetworkOrThrow(NETWORK_ID);
        (contractAddresses as any).tec = '0xee0cec63753081f853145bc93a0f2988c9499925';
        const domain = {
            name: '0x Protocol Trade Execution Coordinator',
            version: '1.0.0',
            verifyingContractAddress: (contractAddresses as any).tec,
        };
        const typedData = eip712Utils.createTypedData(
            TEC_APPROVAL_SCHEMA.name,
            { TECApproval: TEC_APPROVAL_SCHEMA.parameters },
            normalizedTecApproval,
            domain,
        );
        const tecApprovalHashBuff = signTypedDataUtils.generateTypedDataHash(typedData);
        const tecApprovalHashHex = `0x${tecApprovalHashBuff.toString('hex')}`;

        const tecApprovalECSignature = await signatureUtils.ecSignHashAsync(
            this._provider,
            tecApprovalHashHex,
            FEE_RECIPIENT,
        );

        // Insert signature into DB
        await fillRequest.createAsync(
            tecApprovalECSignature,
            approvalExpirationTimeSeconds,
            signedTransaction.signerAddress,
            orders,
        );

        return {
            signature: tecApprovalECSignature,
            expiration: approvalExpirationTimeSeconds,
        };
    }
}
