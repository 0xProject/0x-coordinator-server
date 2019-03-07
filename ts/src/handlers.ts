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
    EventTypes,
    RequestTransactionErrors,
    RequestTransactionResponse,
    Response,
    TECApproval,
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

        // 3. Check if at least one order in calldata has the TEC's feeRecipientAddress
        let orders: OrderWithoutExchangeAddress[] = [];
        try {
            orders = Handlers._getOrdersFromDecodedCallData(decodedCalldata);
        } catch (err) {
            res.status(HttpStatus.BAD_REQUEST).send(err.message);
            return;
        }
        const tecOrders = _.filter(orders, order => utils.isTECFeeRecipient(order.feeRecipientAddress));
        if (_.isEmpty(tecOrders)) {
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
                    tecOrders,
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
                        ordersWithoutExchangeAddress: tecOrders,
                        zeroExTransaction: unsignedTransaction,
                        tecSignature: response.body.signature,
                        tecSignatureExpiration: response.body.expiration,
                    },
                };
                this._broadcastCallback(fillRequestAcceptedEvent);
                return;
            }

            case ExchangeMethods.CancelOrder:
            case ExchangeMethods.BatchCancelOrders: {
                const response = await this._handleCancelsAsync(tecOrders, signedTransaction);
                res.status(response.status).send(response.body);
                return;
            }

            default:
                res.status(HttpStatus.BAD_REQUEST).send(RequestTransactionErrors.InvalidFunctionCall);
                return;
        }
    }
    private async _handleCancelsAsync(
        tecOrders: OrderWithoutExchangeAddress[],
        signedTransaction: SignedZeroExTransaction,
    ): Promise<Response> {
        for (const order of tecOrders) {
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
                ordersWithoutExchangeAddress: tecOrders,
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
        tecOrders: OrderWithoutExchangeAddress[],
        signedTransaction: SignedZeroExTransaction,
        takerAssetFillAmounts: BigNumber[],
    ): Promise<Response> {
        // Takers can only request to fill an order entirely once. If they do multiple
        // partial fills, we keep track and make sure they have a sufficient partial fill
        // amount left for this request to get approved.
        const takerAddress = signedTransaction.signerAddress; // Core assumption
        let orderHashToFillAmount = await transactionModel.getOrderHashToFillAmountRequestedAsync(
            tecOrders,
            takerAddress,
        );
        for (let i = 0; i < tecOrders.length; i++) {
            const tecOrder = tecOrders[i];
            const orderHash = orderModel.getHash(tecOrder);
            const takerAssetFillAmount = takerAssetFillAmounts[i];
            const previouslyRequestedFillAmount = orderHashToFillAmount[orderHash] || new BigNumber(0);
            const totalRequestedFillAmount = previouslyRequestedFillAmount.plus(takerAssetFillAmount);
            if (totalRequestedFillAmount.gt(tecOrder.takerAssetAmount)) {
                return {
                    status: HttpStatus.BAD_REQUEST,
                    body: RequestTransactionErrors.FillRequestsExceededTakerAssetAmount,
                };
            }

            // If cancelled, reject the request
            const isCancelled = await orderModel.isCancelledAsync(tecOrder);
            if (isCancelled) {
                return {
                    status: HttpStatus.BAD_REQUEST,
                    body: RequestTransactionErrors.OrderCancelled,
                };
            }
        }

        // TODO(fabio:)
        // Get all unexpired fillAmounts for each order (irrespective of taker)
        // Get how much remains to be filled of each order [blockchain]
        // Add both, and see if requested amount still fits. If yes, reserve and submit on chain
        // Note: To reserve, we need to add the transaction to DB... but also need to have a way to make it
        // "reserved"...
        orderHashToFillAmount = await transactionModel.getOrderHashToFillAmountRequestedAsync(tecOrders);

        // TODO: Delegated fill
        // - Check that no unexpired signatures outstanding
        ////// await transactionModel.findByOrdersAsync(tecOrders);
        // const hasUnexpiredSignatures = await transactionModel.hasUnexpiredSignaturesAsync(
        //     tecOrders,
        //     signedTransaction.signerAddress,
        // );
        // if (!hasUnexpiredSignatures) {
        //     // Deletage the fill
        //     return {
        //         status: HttpStatus.OK,
        //         body: 'TODO',
        //     };
        // }

        // - if exist, do undelegated, otherwise send tx

        // Undelegated fill
        const unsignedTransaction = utils.getUnsignedTransaction(signedTransaction);
        const fillRequestReceivedEvent = {
            type: EventTypes.FillRequestReceived,
            data: {
                functionName,
                ordersWithoutExchangeAddress: tecOrders,
                zeroExTransaction: unsignedTransaction,
            },
        };
        this._broadcastCallback(fillRequestReceivedEvent);
        await utils.sleepAsync(SELECTIVE_DELAY_MS); // Add selective delay
        // TODO: Check if orders still not cancelled (might have been cancelled during the delay period)
        // TODO 2: Add test for this edge-case, where order cancelled during selective delay
        const response = await this._generateAndStoreSignatureAsync(
            signedTransaction,
            tecOrders,
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
        await transactionModel.createAsync(
            tecApprovalECSignature,
            approvalExpirationTimeSeconds,
            signedTransaction.signerAddress,
            orders,
            takerAssetFillAmounts,
        );

        return {
            signature: tecApprovalECSignature,
            expiration: approvalExpirationTimeSeconds,
        };
    }
}
