import { getContractAddressesForNetworkOrThrow } from '@0x/contract-addresses';
import { ContractWrappers, OrderAndTraderInfo } from '@0x/contract-wrappers';
import {
    eip712Utils,
    orderCalculationUtils,
    orderHashUtils,
    signatureUtils,
    transactionHashUtils,
} from '@0x/order-utils';
import { Web3ProviderEngine } from '@0x/subproviders';
import { Order, SignatureType, SignedOrder, SignedZeroExTransaction } from '@0x/types';
import { BigNumber, DecodedCalldata, signTypedDataUtils } from '@0x/utils';
import * as ethUtil from 'ethereumjs-util';
import * as express from 'express';
import * as HttpStatus from 'http-status-codes';
import * as _ from 'lodash';

import { ValidationError, ValidationErrorCodes, ValidationErrorItem } from './errors';
import { orderModel } from './models/order_model';
import { transactionModel } from './models/transaction_model';
import * as requestTransactionSchema from './schemas/request_transaction_schema.json';
import * as softCancelsSchema from './schemas/soft_cancels_schema.json';
import {
    BroadcastCallback,
    Configs,
    EventTypes,
    NetworkIdToContractWrappers,
    NetworkIdToProvider,
    RequestTransactionResponse,
    Response,
} from './types';
import { utils } from './utils';

const NULL_ADDRESS = '0x0000000000000000000000000000000000000000';

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

    CancelOrder = 'cancelOrder',
    BatchCancelOrders = 'batchCancelOrders',
}

export class Handlers {
    private readonly _networkIdToProvider: NetworkIdToProvider;
    private readonly _broadcastCallback: BroadcastCallback;
    private readonly _networkIdToContractWrappers: NetworkIdToContractWrappers;
    private readonly _configs: Configs;
    private static _calculateRemainingFillableTakerAssetAmount(
        signedOrder: SignedOrder,
        orderAndTraderInfo: OrderAndTraderInfo,
    ): BigNumber {
        const orderInfo = orderAndTraderInfo.orderInfo;
        const traderInfo = orderAndTraderInfo.traderInfo;

        const minSet = [];

        // Calculate min of balance & allowance of taker's takerAsset
        if (signedOrder.takerAddress !== NULL_ADDRESS) {
            const maxTakerAssetFillAmountGivenTakerConstraints = BigNumber.min(
                traderInfo.takerBalance,
                traderInfo.takerAllowance,
            );
            minSet.push(maxTakerAssetFillAmountGivenTakerConstraints);
        }

        // Calculate min of balance & allowance of maker's makerAsset -> translate into takerAsset amount
        const maxMakerAssetFillAmount = BigNumber.min(traderInfo.makerBalance, traderInfo.makerAllowance);
        const maxTakerAssetFillAmountGivenMakerConstraints = orderCalculationUtils.getTakerFillAmount(
            signedOrder,
            maxMakerAssetFillAmount,
        );
        minSet.push(maxTakerAssetFillAmountGivenMakerConstraints);

        // Calculate min of balance & allowance of taker's ZRX -> translate into takerAsset amount
        if (!signedOrder.takerFee.eq(0)) {
            const takerZRXAvailable = BigNumber.min(traderInfo.takerZrxBalance, traderInfo.takerZrxAllowance);
            const maxTakerAssetFillAmountGivenTakerZRXConstraints = takerZRXAvailable
                .multipliedBy(signedOrder.takerAssetAmount)
                .div(signedOrder.takerFee)
                .integerValue(BigNumber.ROUND_FLOOR);
            minSet.push(maxTakerAssetFillAmountGivenTakerZRXConstraints);
        }

        // Calculate min of balance & allowance of maker's ZRX -> translate into takerAsset amount
        if (!signedOrder.makerFee.eq(0)) {
            const makerZRXAvailable = BigNumber.min(traderInfo.makerZrxBalance, traderInfo.makerZrxAllowance);
            const maxTakerAssetFillAmountGivenMakerZRXConstraints = makerZRXAvailable
                .multipliedBy(signedOrder.takerAssetAmount)
                .div(signedOrder.makerFee)
                .integerValue(BigNumber.ROUND_FLOOR);
            minSet.push(maxTakerAssetFillAmountGivenMakerZRXConstraints);
        }

        const remainingTakerAssetFillAmount = signedOrder.takerAssetAmount.minus(orderInfo.orderTakerAssetFilledAmount);
        minSet.push(remainingTakerAssetFillAmount);

        const maxTakerAssetFillAmount = BigNumber.min(...minSet);
        return maxTakerAssetFillAmount;
    }
    private static _getOrdersFromDecodedCalldata(decodedCalldata: DecodedCalldata, networkId: number): Order[] {
        const contractAddresses = getContractAddressesForNetworkOrThrow(networkId);

        switch (decodedCalldata.functionName) {
            case ExchangeMethods.FillOrder:
            case ExchangeMethods.FillOrKillOrder:
            case ExchangeMethods.FillOrderNoThrow:
            case ExchangeMethods.CancelOrder: {
                const orderWithoutExchangeAddress = decodedCalldata.functionArguments.order;
                const order = {
                    ...orderWithoutExchangeAddress,
                    exchangeAddress: contractAddresses.exchange,
                };
                return [order];
            }

            case ExchangeMethods.BatchFillOrders:
            case ExchangeMethods.BatchFillOrKillOrders:
            case ExchangeMethods.BatchFillOrdersNoThrow:
            case ExchangeMethods.MarketSellOrders:
            case ExchangeMethods.MarketSellOrdersNoThrow:
            case ExchangeMethods.MarketBuyOrders:
            case ExchangeMethods.MarketBuyOrdersNoThrow:
            case ExchangeMethods.BatchCancelOrders: {
                const ordersWithoutExchangeAddress = decodedCalldata.functionArguments.orders;
                const orders = _.map(ordersWithoutExchangeAddress, orderWithoutExchangeAddress => {
                    return {
                        ...orderWithoutExchangeAddress,
                        exchangeAddress: contractAddresses.exchange,
                    };
                });
                return orders;
            }

            default:
                throw utils.getInvalidFunctionCallError(decodedCalldata.functionName);
        }
    }
    constructor(networkIdToProvider: NetworkIdToProvider, configs: Configs, broadcastCallback: BroadcastCallback) {
        this._networkIdToProvider = networkIdToProvider;
        this._broadcastCallback = broadcastCallback;
        this._configs = configs;
        this._networkIdToContractWrappers = {};
        _.each(networkIdToProvider, (provider: Web3ProviderEngine, networkIdStr: string) => {
            const networkId = _.parseInt(networkIdStr);
            const contractAddresses = configs.NETWORK_ID_TO_CONTRACT_ADDRESSES
                ? configs.NETWORK_ID_TO_CONTRACT_ADDRESSES[networkId]
                : undefined;
            const contractWrappers = new ContractWrappers(provider, {
                networkId,
                contractAddresses,
            });
            this._networkIdToContractWrappers[networkId] = contractWrappers;
        });
    }
    public async postRequestTransactionAsync(req: express.Request, res: express.Response): Promise<void> {
        // 1. Validate request schema
        utils.validateSchema(req.body, requestTransactionSchema);
        const txOrigin = req.body.txOrigin;
        const networkId = req.networkId;

        // 2. Decode the supplied transaction data
        const signedTransaction: SignedZeroExTransaction = {
            ...req.body.signedTransaction,
            salt: new BigNumber(req.body.signedTransaction.salt),
        };
        let decodedCalldata: DecodedCalldata;
        try {
            const contractWrappers = this._networkIdToContractWrappers[networkId];
            decodedCalldata = contractWrappers
                .getAbiDecoder()
                .decodeCalldataOrThrow(signedTransaction.data, 'Exchange');
        } catch (err) {
            throw new ValidationError([
                {
                    field: 'signedTransaction.data',
                    code: ValidationErrorCodes.ZeroExTransactionDecodingFailed,
                    reason: '0x transaction data decoding failed',
                },
            ]);
        }

        // 3. Check if at least one order in calldata has the Coordinator's feeRecipientAddress
        let orders: Order[] = [];
        orders = Handlers._getOrdersFromDecodedCalldata(decodedCalldata, networkId);
        const coordinatorOrders = _.filter(orders, order => {
            const coordinatorFeeRecipients = this._configs.NETWORK_ID_TO_SETTINGS[networkId].FEE_RECIPIENTS;
            const coordinatorFeeRecipientAddresses = _.map(
                coordinatorFeeRecipients,
                feeRecipient => feeRecipient.ADDRESS,
            );
            return _.includes(coordinatorFeeRecipientAddresses, order.feeRecipientAddress);
        });
        if (_.isEmpty(coordinatorOrders)) {
            throw new ValidationError([
                {
                    field: 'signedTransaction.data',
                    code: ValidationErrorCodes.NoCoordinatorOrdersIncluded,
                    reason:
                        '0x transaction data does not include any orders involving this coordinators feeRecipientAddresses',
                },
            ]);
        }

        // 4. Enforce that a 0x transaction hasn't been used before. This prevents someone from requesting
        // the same transaction with a different `txOrigin` in an attempt to fill the order through an
        // alternative tx.origin entry-point.
        const transactionHash = transactionHashUtils.getTransactionHashHex(signedTransaction);
        const transactionIfExists = await transactionModel.findByHashAsync(transactionHash);
        if (transactionIfExists !== undefined) {
            throw new ValidationError([
                {
                    field: 'signedTransaction',
                    code: ValidationErrorCodes.TransactionAlreadyUsed,
                    reason: `A transaction can only be approved once. To request approval to perform the same actions, generate and sign an identical transaction with a different salt value.`,
                },
            ]);
        }

        // 5. Validate the 0x transaction signature
        const provider = this._networkIdToProvider[networkId];
        const isValidSignature = await signatureUtils.isValidSignatureAsync(
            provider,
            transactionHash,
            signedTransaction.signature,
            signedTransaction.signerAddress,
        );
        if (!isValidSignature) {
            throw new ValidationError([
                {
                    field: 'signedTransaction.signature',
                    code: ValidationErrorCodes.InvalidZeroExTransactionSignature,
                    reason: '0x transaction signature is invalid',
                },
            ]);
        }

        // 6. Handle the request
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
            case ExchangeMethods.MarketBuyOrdersNoThrow: {
                const takerAddress = signedTransaction.signerAddress;
                const takerAssetFillAmounts = await this._getTakerAssetFillAmountsFromDecodedCalldataAsync(
                    decodedCalldata,
                    takerAddress,
                    networkId,
                );
                const response = await this._handleFillsAsync(
                    coordinatorOrders,
                    txOrigin,
                    signedTransaction,
                    takerAssetFillAmounts,
                    networkId,
                );
                res.status(response.status).send(response.body);
                // After responding to taker's request, we broadcast the fill acceptance to all WS connections
                const fillRequestAcceptedEvent = {
                    type: EventTypes.FillRequestAccepted,
                    data: {
                        functionName: decodedCalldata.functionName,
                        orders: coordinatorOrders,
                        txOrigin,
                        signedTransaction,
                        approvalSignatures: response.body.signatures,
                        approvalExpirationTimeSeconds: response.body.expirationTimeSeconds,
                    },
                };
                this._broadcastCallback(fillRequestAcceptedEvent, networkId);
                return;
            }

            case ExchangeMethods.CancelOrder:
            case ExchangeMethods.BatchCancelOrders: {
                const response = await this._handleCancelsAsync(
                    coordinatorOrders,
                    signedTransaction,
                    networkId,
                    txOrigin,
                );
                res.status(response.status).send(response.body);
                return;
            }

            default:
                throw utils.getInvalidFunctionCallError(decodedCalldata.functionName);
        }
    }
    // tslint:disable-next-line:prefer-function-over-method
    public async postSoftCancelsAsync(req: express.Request, res: express.Response): Promise<void> {
        utils.validateSchema(req.body, softCancelsSchema);

        const softCancelsFound = await orderModel.findSoftCancelledOrdersByHashAsync(req.body.orderHashes);
        res.status(HttpStatus.OK).send({
            orderHashes: softCancelsFound,
        });
    }
    private async _getTakerAssetFillAmountsFromDecodedCalldataAsync(
        decodedCalldata: DecodedCalldata,
        takerAddress: string,
        networkId: number,
    ): Promise<BigNumber[]> {
        const contractAddresses = getContractAddressesForNetworkOrThrow(networkId);
        let takerAssetFillAmounts: BigNumber[] = [];
        switch (decodedCalldata.functionName) {
            case ExchangeMethods.FillOrder:
            case ExchangeMethods.FillOrKillOrder:
            case ExchangeMethods.FillOrderNoThrow:
                takerAssetFillAmounts.push(decodedCalldata.functionArguments.takerAssetFillAmount);
                break;

            case ExchangeMethods.BatchFillOrders:
            case ExchangeMethods.BatchFillOrKillOrders:
            case ExchangeMethods.BatchFillOrdersNoThrow:
                takerAssetFillAmounts = decodedCalldata.functionArguments.takerAssetFillAmounts;
                break;

            case ExchangeMethods.MarketSellOrders:
            case ExchangeMethods.MarketSellOrdersNoThrow: {
                const signedOrders = utils.getSignedOrdersFromOrderWithoutExchangeAddresses(
                    decodedCalldata.functionArguments.orders,
                    decodedCalldata.functionArguments.signatures,
                    contractAddresses.exchange,
                );
                const takerAddresses: string[] = [];
                _.times(signedOrders.length, () => {
                    takerAddresses.push(takerAddress);
                });
                const contractWrappers = this._networkIdToContractWrappers[networkId];
                const orderAndTraderInfos = await contractWrappers.orderValidator.getOrdersAndTradersInfoAsync(
                    signedOrders,
                    takerAddresses,
                );
                let totalTakerAssetAmount: BigNumber = decodedCalldata.functionArguments.takerAssetFillAmount;
                _.each(orderAndTraderInfos, (orderAndTraderInfo: OrderAndTraderInfo, i: number) => {
                    const remainingFillableTakerAssetAmount = Handlers._calculateRemainingFillableTakerAssetAmount(
                        signedOrders[i],
                        orderAndTraderInfo,
                    );
                    const takerAssetFillAmount = totalTakerAssetAmount.isLessThan(remainingFillableTakerAssetAmount)
                        ? totalTakerAssetAmount
                        : remainingFillableTakerAssetAmount;
                    totalTakerAssetAmount = totalTakerAssetAmount.minus(takerAssetFillAmount);
                    takerAssetFillAmounts.push(takerAssetFillAmount);
                });
                break;
            }

            case ExchangeMethods.MarketBuyOrders:
            case ExchangeMethods.MarketBuyOrdersNoThrow: {
                const signedOrders = utils.getSignedOrdersFromOrderWithoutExchangeAddresses(
                    decodedCalldata.functionArguments.orders,
                    decodedCalldata.functionArguments.signatures,
                    contractAddresses.exchange,
                );
                const takerAddresses: string[] = [];
                _.times(signedOrders.length, () => {
                    takerAddresses.push(takerAddress);
                });
                const contractWrappers = this._networkIdToContractWrappers[networkId];
                const orderAndTraderInfos = await contractWrappers.orderValidator.getOrdersAndTradersInfoAsync(
                    signedOrders,
                    takerAddresses,
                );
                let totalMakerAssetAmount: BigNumber = decodedCalldata.functionArguments.makerAssetFillAmount;
                _.each(orderAndTraderInfos, (orderAndTraderInfo: OrderAndTraderInfo, i: number) => {
                    const signedOrder = signedOrders[i];
                    const remainingFillableTakerAssetAmount = Handlers._calculateRemainingFillableTakerAssetAmount(
                        signedOrder,
                        orderAndTraderInfo,
                    );
                    const totalTakerAssetAmountAtOrderExchangeRate = orderCalculationUtils.getTakerFillAmount(
                        signedOrder,
                        totalMakerAssetAmount,
                    );
                    const takerAssetFillAmount = totalTakerAssetAmountAtOrderExchangeRate.isLessThan(
                        remainingFillableTakerAssetAmount,
                    )
                        ? totalTakerAssetAmountAtOrderExchangeRate
                        : remainingFillableTakerAssetAmount;

                    const remainingTotalTakerAssetAmount = totalTakerAssetAmountAtOrderExchangeRate.minus(
                        takerAssetFillAmount,
                    );
                    totalMakerAssetAmount = orderCalculationUtils.getMakerFillAmount(
                        signedOrder,
                        remainingTotalTakerAssetAmount,
                    );
                    takerAssetFillAmounts.push(takerAssetFillAmount);
                });
                break;
            }

            default:
                throw utils.getInvalidFunctionCallError(decodedCalldata.functionName);
        }
        return takerAssetFillAmounts;
    }
    private async _handleCancelsAsync(
        coordinatorOrders: Order[],
        signedTransaction: SignedZeroExTransaction,
        networkId: number,
        txOrigin: string,
    ): Promise<Response> {
        for (const order of coordinatorOrders) {
            if (signedTransaction.signerAddress !== order.makerAddress) {
                throw new ValidationError([
                    {
                        field: 'signedTransaction.data',
                        code: ValidationErrorCodes.OnlyMakerCanCancelOrders,
                        reason: 'Cannot cancel order whose maker is not the 0x transaction signerAddress',
                    },
                ]);
            }
        }
        // Once we are sure all orders can be cancelled, we cancel them all at once
        for (const order of coordinatorOrders) {
            await orderModel.cancelAsync(order);
        }
        const unsignedTransaction = utils.getUnsignedTransaction(signedTransaction);
        const cancelRequestAccepted = {
            type: EventTypes.CancelRequestAccepted,
            data: {
                orders: coordinatorOrders,
                transaction: unsignedTransaction,
            },
        };
        this._broadcastCallback(cancelRequestAccepted, networkId);
        const outstandingFillSignatures = await transactionModel.getOutstandingFillSignaturessByOrdersAsync(
            coordinatorOrders,
        );

        // HACK(fabio): We want to re-use approvalSignatures for cancellation requests
        // but they don't expire. So we hard-code `0` as the expiration
        const ZERO = 0;
        const response = await this._generateApprovalSignatureAsync(
            txOrigin,
            signedTransaction,
            coordinatorOrders,
            networkId,
            ZERO,
        );

        return {
            status: HttpStatus.OK,
            body: {
                outstandingFillSignatures,
                cancellationSignatures: response.signatures,
            },
        };
    }
    private async _handleFillsAsync(
        coordinatorOrders: Order[],
        txOrigin: string,
        signedTransaction: SignedZeroExTransaction,
        takerAssetFillAmounts: BigNumber[],
        networkId: number,
    ): Promise<Response> {
        await this._validateFillsAllowedOrThrowAsync(
            signedTransaction,
            coordinatorOrders,
            takerAssetFillAmounts,
            txOrigin,
        );

        const transactionHash = transactionHashUtils.getTransactionHashHex(signedTransaction);
        const fillRequestReceivedEvent = {
            type: EventTypes.FillRequestReceived,
            data: {
                transactionHash,
            },
        };
        this._broadcastCallback(fillRequestReceivedEvent, networkId);
        await utils.sleepAsync(this._configs.SELECTIVE_DELAY_MS); // Await selective delay

        // Check that still a valid fill request after selective delay
        if (this._configs.SELECTIVE_DELAY_MS !== 0) {
            await this._validateFillsAllowedOrThrowAsync(
                signedTransaction,
                coordinatorOrders,
                takerAssetFillAmounts,
                txOrigin,
            );
        }

        const approvalExpirationTimeSeconds =
            utils.getCurrentTimestampSeconds() + this._configs.EXPIRATION_DURATION_SECONDS;
        const response = await this._generateApprovalSignatureAsync(
            txOrigin,
            signedTransaction,
            coordinatorOrders,
            networkId,
            approvalExpirationTimeSeconds,
        );

        // Insert signature into DB
        await transactionModel.createAsync(
            transactionHash,
            txOrigin,
            response.signatures,
            response.expirationTimeSeconds,
            signedTransaction.signerAddress,
            coordinatorOrders,
            takerAssetFillAmounts,
        );

        return {
            status: HttpStatus.OK,
            body: response,
        };
    }
    private async _generateApprovalSignatureAsync(
        txOrigin: string,
        signedTransaction: SignedZeroExTransaction,
        coordinatorOrders: Order[],
        networkId: number,
        approvalExpirationTimeSeconds: number,
    ): Promise<RequestTransactionResponse> {
        const contractWrappers = this._networkIdToContractWrappers[networkId];
        const typedData = eip712Utils.createCoordinatorApprovalTypedData(
            signedTransaction,
            contractWrappers.coordinator.address,
            txOrigin,
            new BigNumber(approvalExpirationTimeSeconds),
        );
        const approvalHashBuff = signTypedDataUtils.generateTypedDataHash(typedData);

        // Since a coordinator can have multiple feeRecipientAddresses,
        // we need to make sure we issue a signature for each feeRecipientAddress
        // found in the orders submitted (i.e., someone can batch fill two coordinator
        // orders, each with a different feeRecipientAddress). In that case, we issue a
        // signature/expiration for each feeRecipientAddress
        const feeRecipientAddressSet = new Set<string>();
        _.each(coordinatorOrders, o => {
            feeRecipientAddressSet.add(o.feeRecipientAddress);
        });
        const signatures = [];
        const feeRecipientAddressesUsed = Array.from(feeRecipientAddressSet);
        for (const feeRecipientAddress of feeRecipientAddressesUsed) {
            const feeRecipientIfExists = _.find(
                this._configs.NETWORK_ID_TO_SETTINGS[networkId].FEE_RECIPIENTS,
                f => f.ADDRESS === feeRecipientAddress,
            );
            if (feeRecipientIfExists === undefined) {
                // This error should never be hit
                throw new Error(
                    `Unexpected error: Found feeRecipientAddress ${feeRecipientAddress} that wasn't specified in config.`,
                );
            }
            const signature = ethUtil.ecsign(approvalHashBuff, Buffer.from(feeRecipientIfExists.PRIVATE_KEY, 'hex'));
            const signatureBuffer = Buffer.concat([
                ethUtil.toBuffer(signature.v),
                signature.r,
                signature.s,
                ethUtil.toBuffer(SignatureType.EIP712),
            ]);
            const approvalSignatureHex = ethUtil.addHexPrefix(signatureBuffer.toString('hex'));
            signatures.push(approvalSignatureHex);
        }

        return {
            signatures,
            expirationTimeSeconds: approvalExpirationTimeSeconds,
        };
    }
    private async _validateFillsAllowedOrThrowAsync(
        signedTransaction: SignedZeroExTransaction,
        coordinatorOrders: Order[],
        takerAssetFillAmounts: BigNumber[],
        txOrigin: string,
    ): Promise<void> {
        // Find all soft-cancelled orders
        const softCancelledOrderHashes = await orderModel.findSoftCancelledOrdersAsync(coordinatorOrders);

        // Takers can only request to fill an order entirely once. If they do multiple
        // partial fills, we keep track and make sure they have a sufficient partial fill
        // amount left for this request to get approved.

        // Verify the fill amounts for all orders that have not been soft-cancelled
        const availableCoordinatorOrders = _.filter(
            coordinatorOrders,
            o => !_.includes(softCancelledOrderHashes, orderHashUtils.getOrderHashHex(o)),
        );

        // Core assumption. If signature type is `Wallet`, then takerAddress = walletContractAddress.
        const takerAddress = signedTransaction.signerAddress;
        const orderHashToFillAmount = await transactionModel.getOrderHashToFillAmountRequestedAsync(
            availableCoordinatorOrders,
            takerAddress,
            txOrigin,
            this._configs.TAKER_CONTRACT_WHITELIST,
        );
        const orderHashesWithInsufficientFillAmounts = [];
        for (let i = 0; i < availableCoordinatorOrders.length; i++) {
            const coordinatorOrder = availableCoordinatorOrders[i];
            const orderHash = orderModel.getHash(coordinatorOrder);
            const takerAssetFillAmount = takerAssetFillAmounts[i];
            const previouslyRequestedFillAmount = orderHashToFillAmount[orderHash] || new BigNumber(0);
            const totalRequestedFillAmount = previouslyRequestedFillAmount.plus(takerAssetFillAmount);
            if (totalRequestedFillAmount.gt(coordinatorOrder.takerAssetAmount)) {
                orderHashesWithInsufficientFillAmounts.push(orderHash);
            }
        }
        const validationErrors: ValidationErrorItem[] = [];
        // If any soft-cancelled orders, include validation error with their orderHashes
        if (softCancelledOrderHashes.length > 0) {
            validationErrors.push({
                field: 'signedTransaction.data',
                code: ValidationErrorCodes.IncludedOrderAlreadySoftCancelled,
                reason: `Cannot fill orders because some have already been soft-cancelled`,
                entities: softCancelledOrderHashes,
            });
        }
        // If any orders with insufficient fill amounts left, include validation error with their orderHashes
        if (orderHashesWithInsufficientFillAmounts.length > 0) {
            validationErrors.push({
                field: 'signedTransaction.data',
                code: ValidationErrorCodes.FillRequestsExceededTakerAssetAmount,
                reason: `A taker can only request to fill an order fully once. This request includes orders which would exceed this limit.`,
                entities: orderHashesWithInsufficientFillAmounts,
            });
        }
        // If any failure conditions (soft-cancels or lacking remaining fill amounts), return the relevant errors
        if (validationErrors.length > 0) {
            throw new ValidationError(validationErrors);
        }
    }
} // tslint:disable:max-file-line-count
