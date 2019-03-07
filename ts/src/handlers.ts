import { ContractWrappers, DecodedCalldata, signatureUtils, transactionHashUtils } from '0x.js';
import { getContractAddressesForNetworkOrThrow } from '@0x/contract-addresses';
import { eip712Utils } from '@0x/order-utils';
import { OrderWithoutExchangeAddress, SignedZeroExTransaction } from '@0x/types';
import { BigNumber, signTypedDataUtils } from '@0x/utils';
import { Provider } from 'ethereum-types';
import * as express from 'express';
import * as HttpStatus from 'http-status-codes';
import * as _ from 'lodash';

import { EXPIRATION_DURATION_SECONDS, FEE_RECIPIENT, NETWORK_ID, SELECTIVE_DELAY_MS } from './config.js';
import { orderModel } from './models/order_model';
import { transactionModel } from './models/transaction_model';
import * as requestTransactionSchema from './schemas/request_transaction_schema.json';
import {
    BroadcastCallback,
    CoordinatorApproval,
    EventTypes,
    RequestTransactionErrors,
    RequestTransactionResponse,
    Response,
} from './types';
import { utils } from './utils';

enum ExchangeMethods {
    FillOrder = 'fillOrder',
    FillOrKillOrder = 'fillOrKillOrder',
    FillOrderNoThrow = 'fillOrderNoThrow',
    BatchFillOrders = 'batchFillOrders',
    BatchFillOrKillOrders = 'batchFillOrKillOrders',
    BatchFillOrdersNoThrow = 'batchFillOrdersNoThrow',
    MarketSellOrders = 'marketSellOrders',
    MarketSellOrdersNoThrow = 'marketSellOrdersNoThrow',
    MarketBuyOrders = 'marketBuyOrders',
    MarketBuyOrdersNoThrow = 'marketBuyOrdersNoThrow',
    MatchOrders = 'matchOrders',

    CancelOrder = 'cancelOrder',
    BatchCancelOrders = 'batchCancelOrders',
}

export class Handlers {
    private readonly _provider: Provider;
    private readonly _broadcastCallback: BroadcastCallback;
    private readonly _contractWrappers: ContractWrappers;
    private static _getTakerAssetFillAmountsFromDecodedCallData(decodedCalldata: DecodedCalldata): BigNumber[] {
        let takerAssetFillAmounts = [];
        switch (decodedCalldata.functionName) {
            case ExchangeMethods.FillOrder:
            case ExchangeMethods.FillOrKillOrder:
            case ExchangeMethods.FillOrderNoThrow:
            case ExchangeMethods.MarketSellOrders:
            case ExchangeMethods.MarketSellOrdersNoThrow:
                takerAssetFillAmounts.push(decodedCalldata.functionArguments.takerAssetFillAmount);
                break;

            case ExchangeMethods.BatchFillOrders:
            case ExchangeMethods.BatchFillOrKillOrders:
            case ExchangeMethods.BatchFillOrdersNoThrow:
                // takerAssetFillAmounts
                takerAssetFillAmounts = decodedCalldata.functionArguments.takerAssetFillAmounts;
                break;

            case ExchangeMethods.MatchOrders:
                // TODO!
                // Must calculate amount that would fill of both orders.
                return [new BigNumber(0), new BigNumber(0)];

            case ExchangeMethods.MarketBuyOrders:
            case ExchangeMethods.MarketBuyOrdersNoThrow:
                // TODO!
                // makerAssetFillAmount
                return [new BigNumber(0)];

            default:
                throw new Error(RequestTransactionErrors.InvalidFunctionCall);
        }
        return takerAssetFillAmounts;
    }
    private static _getOrdersFromDecodedCallData(decodedCalldata: DecodedCalldata): OrderWithoutExchangeAddress[] {
        switch (decodedCalldata.functionName) {
            case ExchangeMethods.FillOrder:
            case ExchangeMethods.FillOrKillOrder:
            case ExchangeMethods.FillOrderNoThrow:
            case ExchangeMethods.CancelOrder:
                return [decodedCalldata.functionArguments.order];

            case ExchangeMethods.BatchFillOrders:
            case ExchangeMethods.BatchFillOrKillOrders:
            case ExchangeMethods.BatchFillOrdersNoThrow:
            case ExchangeMethods.MarketSellOrders:
            case ExchangeMethods.MarketSellOrdersNoThrow:
            case ExchangeMethods.MarketBuyOrders:
            case ExchangeMethods.MarketBuyOrdersNoThrow:
            case ExchangeMethods.BatchCancelOrders:
                return decodedCalldata.functionArguments.orders;

            case ExchangeMethods.MatchOrders:
                const leftOrder = decodedCalldata.functionArguments.leftOrder;
                const rightOrder = decodedCalldata.functionArguments.rightOrder;
                return [leftOrder, rightOrder];

            default:
                throw new Error(RequestTransactionErrors.InvalidFunctionCall);
        }
    }
    constructor(provider: Provider, broadcastCallback: BroadcastCallback) {
        this._provider = provider;
        this._broadcastCallback = broadcastCallback;
        this._contractWrappers = new ContractWrappers(provider, {
            networkId: NETWORK_ID,
        });
    }
    public async postRequestTransactionAsync(req: express.Request, res: express.Response): Promise<void> {
        // 1. Validate request schema
        utils.validateSchema(req.body, requestTransactionSchema);

        // 2. Decode the supplied transaction data
        const signedTransaction: SignedZeroExTransaction = {
            ...req.body.signedTransaction,
            salt: new BigNumber(req.body.signedTransaction.salt),
        };
        let decodedCalldata: DecodedCalldata;
        try {
            decodedCalldata = this._contractWrappers
                .getAbiDecoder()
                .decodeCalldataOrThrow(signedTransaction.data, 'Exchange');
        } catch (err) {
            res.status(HttpStatus.BAD_REQUEST).send(RequestTransactionErrors.DecodingTransactionFailed);
            return;
        }

        // 3. Check if at least one order in calldata has the Coordinator's feeRecipientAddress
        let orders: OrderWithoutExchangeAddress[] = [];
        try {
            orders = Handlers._getOrdersFromDecodedCallData(decodedCalldata);
        } catch (err) {
            res.status(HttpStatus.BAD_REQUEST).send(err.message);
            return;
        }
        const coordinatorOrders = _.filter(orders, order => utils.isCoordinatorFeeRecipient(order.feeRecipientAddress));
        if (_.isEmpty(coordinatorOrders)) {
            res.status(HttpStatus.BAD_REQUEST).send(RequestTransactionErrors.CoordinatorFeeRecipientNotFound);
            return;
        }

        // 4. Validate the 0x transaction signature
        const transactionHash = transactionHashUtils.getTransactionHashHex(signedTransaction);
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
            case ExchangeMethods.FillOrder:
            case ExchangeMethods.FillOrKillOrder:
            case ExchangeMethods.FillOrderNoThrow:
            case ExchangeMethods.BatchFillOrders:
            case ExchangeMethods.BatchFillOrKillOrders:
            case ExchangeMethods.BatchFillOrdersNoThrow:
            case ExchangeMethods.MarketSellOrders:
            case ExchangeMethods.MarketSellOrdersNoThrow:
            case ExchangeMethods.MarketBuyOrders:
            case ExchangeMethods.MarketBuyOrdersNoThrow:
            case ExchangeMethods.MatchOrders: {
                const takerAssetFillAmounts = Handlers._getTakerAssetFillAmountsFromDecodedCallData(decodedCalldata);
                const response = await this._handleFillsAsync(
                    decodedCalldata.functionName,
                    coordinatorOrders,
                    signedTransaction,
                    takerAssetFillAmounts,
                );
                res.status(response.status).send(response.body);
                // After responding to taker's request, we broadcast the fill acceptance to all WS connections
                const unsignedTransaction = utils.getUnsignedTransaction(signedTransaction);
                const fillRequestAcceptedEvent = {
                    type: EventTypes.FillRequestAccepted,
                    data: {
                        functionName: decodedCalldata.functionName,
                        ordersWithoutExchangeAddress: coordinatorOrders,
                        zeroExTransaction: unsignedTransaction,
                        coordinatorSignature: response.body.signature,
                        coordinatorSignatureExpiration: response.body.expiration,
                    },
                };
                this._broadcastCallback(fillRequestAcceptedEvent);
                return;
            }

            case ExchangeMethods.CancelOrder:
            case ExchangeMethods.BatchCancelOrders: {
                const response = await this._handleCancelsAsync(coordinatorOrders, signedTransaction);
                res.status(response.status).send(response.body);
                return;
            }

            default:
                res.status(HttpStatus.BAD_REQUEST).send(RequestTransactionErrors.InvalidFunctionCall);
                return;
        }
    }
    private async _handleCancelsAsync(
        coordinatorOrders: OrderWithoutExchangeAddress[],
        signedTransaction: SignedZeroExTransaction,
    ): Promise<Response> {
        for (const order of coordinatorOrders) {
            try {
                if (signedTransaction.signerAddress !== order.makerAddress) {
                    throw new Error(RequestTransactionErrors.CancellationTransactionNotSignedByMaker);
                }
            } catch (err) {
                return {
                    status: HttpStatus.BAD_REQUEST,
                    body: err.message,
                };
            }
            await orderModel.cancelAsync(order);
        }
        const unsignedTransaction = utils.getUnsignedTransaction(signedTransaction);
        const cancelRequestAccepted = {
            type: EventTypes.CancelRequestAccepted,
            data: {
                ordersWithoutExchangeAddress: coordinatorOrders,
                zeroExTransaction: unsignedTransaction,
            },
        };
        this._broadcastCallback(cancelRequestAccepted);
        return {
            status: HttpStatus.OK,
        };
    }
    private async _handleFillsAsync(
        functionName: string,
        coordinatorOrders: OrderWithoutExchangeAddress[],
        signedTransaction: SignedZeroExTransaction,
        takerAssetFillAmounts: BigNumber[],
    ): Promise<Response> {
        // Takers can only request to fill an order entirely once. If they do multiple
        // partial fills, we keep track and make sure they have a sufficient partial fill
        // amount left for this request to get approved.

        // Core assumption. If signature type is `Wallet`, then takerAddress = walletContractAddress.
        const takerAddress = signedTransaction.signerAddress;
        const orderHashToFillAmount = await transactionModel.getOrderHashToFillAmountRequestedAsync(
            coordinatorOrders,
            takerAddress,
        );
        for (let i = 0; i < coordinatorOrders.length; i++) {
            const coordinatorOrder = coordinatorOrders[i];
            const orderHash = orderModel.getHash(coordinatorOrder);
            const takerAssetFillAmount = takerAssetFillAmounts[i];
            const previouslyRequestedFillAmount = orderHashToFillAmount[orderHash] || new BigNumber(0);
            const totalRequestedFillAmount = previouslyRequestedFillAmount.plus(takerAssetFillAmount);
            if (totalRequestedFillAmount.gt(coordinatorOrder.takerAssetAmount)) {
                return {
                    status: HttpStatus.BAD_REQUEST,
                    body: RequestTransactionErrors.FillRequestsExceededTakerAssetAmount,
                };
            }

            // If cancelled, reject the request
            const isCancelled = await orderModel.isCancelledAsync(coordinatorOrder);
            if (isCancelled) {
                return {
                    status: HttpStatus.BAD_REQUEST,
                    body: RequestTransactionErrors.OrderCancelled,
                };
            }
        }

        const unsignedTransaction = utils.getUnsignedTransaction(signedTransaction);
        const fillRequestReceivedEvent = {
            type: EventTypes.FillRequestReceived,
            data: {
                functionName,
                ordersWithoutExchangeAddress: coordinatorOrders,
                zeroExTransaction: unsignedTransaction,
            },
        };
        this._broadcastCallback(fillRequestReceivedEvent);
        await utils.sleepAsync(SELECTIVE_DELAY_MS); // Add selective delay
        // TODO: Check if orders still not cancelled (might have been cancelled during the delay period)
        // TODO 2: Add test for this edge-case, where order cancelled during selective delay
        const response = await this._generateAndStoreSignatureAsync(
            signedTransaction,
            coordinatorOrders,
            takerAssetFillAmounts,
        );
        return {
            status: HttpStatus.OK,
            body: response,
        };
    }
    private async _generateAndStoreSignatureAsync(
        signedTransaction: SignedZeroExTransaction,
        orders: OrderWithoutExchangeAddress[],
        takerAssetFillAmounts: BigNumber[],
    ): Promise<RequestTransactionResponse> {
        // generate signature & expiry and add to DB
        const approvalExpirationTimeSeconds = utils.getCurrentTimestampSeconds() + EXPIRATION_DURATION_SECONDS;
        const transactionHash = transactionHashUtils.getTransactionHashHex(signedTransaction);
        const coordinatorApproval: CoordinatorApproval = {
            transactionHash,
            transactionSignature: signedTransaction.signature,
            approvalExpirationTimeSeconds,
        };
        const COORDINATOR_APPROVAL_SCHEMA = {
            name: 'CoordinatorApproval',
            parameters: [
                { name: 'transactionHash', type: 'bytes32' },
                { name: 'transactionSignature', type: 'bytes' },
                { name: 'approvalExpirationTimeSeconds', type: 'uint256' },
            ],
        };
        const normalizedCoordinatorApproval = _.mapValues(coordinatorApproval, value => {
            return !_.isString(value) ? value.toString() : value;
        });
        // HACK(fabio): Hard-code fake Coordinator address until we've deployed the contract and added
        // the address to `@0x/contract-addresses`
        const contractAddresses = getContractAddressesForNetworkOrThrow(NETWORK_ID);
        (contractAddresses as any).coordinator = '0xee0cec63753081f853145bc93a0f2988c9499925';
        const domain = {
            name: '0x Protocol Trade Execution Coordinator',
            version: '1.0.0',
            verifyingContractAddress: (contractAddresses as any).coordinator,
        };
        const typedData = eip712Utils.createTypedData(
            COORDINATOR_APPROVAL_SCHEMA.name,
            { CoordinatorApproval: COORDINATOR_APPROVAL_SCHEMA.parameters },
            normalizedCoordinatorApproval,
            domain,
        );
        const coordinatorApprovalHashBuff = signTypedDataUtils.generateTypedDataHash(typedData);
        const coordinatorApprovalHashHex = `0x${coordinatorApprovalHashBuff.toString('hex')}`;

        const coordinatorApprovalECSignature = await signatureUtils.ecSignHashAsync(
            this._provider,
            coordinatorApprovalHashHex,
            FEE_RECIPIENT,
        );

        // Insert signature into DB
        await transactionModel.createAsync(
            coordinatorApprovalECSignature,
            approvalExpirationTimeSeconds,
            signedTransaction.signerAddress,
            orders,
            takerAssetFillAmounts,
        );

        return {
            signature: coordinatorApprovalECSignature,
            expiration: approvalExpirationTimeSeconds,
        };
    }
}
