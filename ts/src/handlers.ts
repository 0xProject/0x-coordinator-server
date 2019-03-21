import { orderUtils } from '@0x/asset-buyer/lib/src/utils/order_utils';
import { getContractAddressesForNetworkOrThrow } from '@0x/contract-addresses';
import { ContractWrappers, OrderAndTraderInfo } from '@0x/contract-wrappers';
import { signatureUtils, transactionHashUtils } from '@0x/order-utils';
import { Web3ProviderEngine } from '@0x/subproviders';
import { Order, SignatureType, SignedOrder, SignedZeroExTransaction } from '@0x/types';
import { BigNumber, DecodedCalldata } from '@0x/utils';
import * as ethUtil from 'ethereumjs-util';
import * as express from 'express';
import * as HttpStatus from 'http-status-codes';
import * as _ from 'lodash';

import { constants } from './constants';
import { ValidationError, ValidationErrorCodes } from './errors';
import { orderModel } from './models/order_model';
import { transactionModel } from './models/transaction_model';
import * as requestTransactionSchema from './schemas/request_transaction_schema.json';
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
    // TODO(fabio): Move this method into @0x/order-utils package
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
        const maxTakerAssetFillAmountGivenMakerConstraints = orderUtils.getTakerFillAmount(
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
    private static async _validateFillsAllowedOrThrowAsync(
        signedTransaction: SignedZeroExTransaction,
        coordinatorOrders: Order[],
        takerAssetFillAmounts: BigNumber[],
    ): Promise<void> {
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
                throw new ValidationError([
                    {
                        field: 'signedTransaction.data',
                        code: ValidationErrorCodes.FillRequestsExceededTakerAssetAmount,
                        reason: `A taker can only request to fill an order fully once. This request would exceed this amount for order with hash ${orderHash}`,
                    },
                ]);
            }

            // If cancelled, reject the request
            const isCancelled = await orderModel.isCancelledAsync(coordinatorOrder);
            if (isCancelled) {
                throw new ValidationError([
                    {
                        field: 'signedTransaction.data',
                        code: ValidationErrorCodes.IncludedOrderAlreadySoftCancelled,
                        reason: `Cannot fill order with hash ${orderHash} because it's already been soft-cancelled`,
                    },
                ]);
            }
        }
    }
    constructor(networkIdToProvider: NetworkIdToProvider, configs: Configs, broadcastCallback: BroadcastCallback) {
        this._networkIdToProvider = networkIdToProvider;
        this._broadcastCallback = broadcastCallback;
        this._configs = configs;
        this._networkIdToContractWrappers = {};
        _.each(networkIdToProvider, (provider: Web3ProviderEngine, networkIdStr: string) => {
            const networkId = _.parseInt(networkIdStr);
            const contractWrappers = new ContractWrappers(provider, {
                networkId,
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

        // 4. Validate the 0x transaction signature
        const transactionHash = transactionHashUtils.getTransactionHashHex(signedTransaction);
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
            case ExchangeMethods.MarketBuyOrdersNoThrow: {
                const takerAddress = signedTransaction.signerAddress;
                const takerAssetFillAmounts = await this._getTakerAssetFillAmountsFromDecodedCalldataAsync(
                    decodedCalldata,
                    takerAddress,
                    networkId,
                );
                const response = await this._handleFillsAsync(
                    decodedCalldata.functionName,
                    coordinatorOrders,
                    txOrigin,
                    signedTransaction,
                    takerAssetFillAmounts,
                    networkId,
                );
                res.status(response.status).send(response.body);
                // After responding to taker's request, we broadcast the fill acceptance to all WS connections
                const unsignedTransaction = utils.getUnsignedTransaction(signedTransaction);
                const fillRequestAcceptedEvent = {
                    type: EventTypes.FillRequestAccepted,
                    data: {
                        functionName: decodedCalldata.functionName,
                        orders: coordinatorOrders,
                        zeroExTransaction: unsignedTransaction,
                        coordinatorSignatures: response.body.signatures,
                        coordinatorSignatureExpiration: response.body.expirationTimeSeconds,
                    },
                };
                this._broadcastCallback(fillRequestAcceptedEvent, networkId);
                return;
            }

            case ExchangeMethods.CancelOrder:
            case ExchangeMethods.BatchCancelOrders: {
                const response = await this._handleCancelsAsync(coordinatorOrders, signedTransaction, networkId);
                res.status(response.status).send(response.body);
                return;
            }

            default:
                throw utils.getInvalidFunctionCallError(decodedCalldata.functionName);
        }
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
                    const totalTakerAssetAmountAtOrderExchangeRate = orderUtils.getTakerFillAmount(
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
                    totalMakerAssetAmount = orderUtils.getMakerFillAmount(signedOrder, remainingTotalTakerAssetAmount);
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
                zeroExTransaction: unsignedTransaction,
            },
        };
        this._broadcastCallback(cancelRequestAccepted, networkId);
        const outstandingSignatures = await transactionModel.getOutstandingSignaturesByOrdersAsync(coordinatorOrders);
        return {
            status: HttpStatus.OK,
            body: {
                outstandingSignatures,
            },
        };
    }
    private async _handleFillsAsync(
        functionName: string,
        coordinatorOrders: Order[],
        txOrigin: string,
        signedTransaction: SignedZeroExTransaction,
        takerAssetFillAmounts: BigNumber[],
        networkId: number,
    ): Promise<Response> {
        await Handlers._validateFillsAllowedOrThrowAsync(signedTransaction, coordinatorOrders, takerAssetFillAmounts);

        const unsignedTransaction = utils.getUnsignedTransaction(signedTransaction);
        const fillRequestReceivedEvent = {
            type: EventTypes.FillRequestReceived,
            data: {
                functionName,
                orders: coordinatorOrders,
                zeroExTransaction: unsignedTransaction,
            },
        };
        this._broadcastCallback(fillRequestReceivedEvent, networkId);
        await utils.sleepAsync(this._configs.SELECTIVE_DELAY_MS); // Await selective delay

        // Check that still a valid fill request after selective delay
        if (this._configs.SELECTIVE_DELAY_MS !== 0) {
            await Handlers._validateFillsAllowedOrThrowAsync(
                signedTransaction,
                coordinatorOrders,
                takerAssetFillAmounts,
            );
        }

        const response = await this._generateAndStoreSignatureAsync(
            txOrigin,
            signedTransaction,
            coordinatorOrders,
            takerAssetFillAmounts,
            networkId,
        );
        return {
            status: HttpStatus.OK,
            body: response,
        };
    }
    private async _generateAndStoreSignatureAsync(
        txOrigin: string,
        signedTransaction: SignedZeroExTransaction,
        coordinatorOrders: Order[],
        takerAssetFillAmounts: BigNumber[],
        networkId: number,
    ): Promise<RequestTransactionResponse> {
        const approvalExpirationTimeSeconds =
            utils.getCurrentTimestampSeconds() + this._configs.EXPIRATION_DURATION_SECONDS;

        const approvalHashBuff = utils.getApprovalHashBuffer(
            signedTransaction,
            constants.COORDINATOR_CONTRACT_ADDRESS,
            txOrigin,
            new BigNumber(approvalExpirationTimeSeconds),
        );

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

        // Insert signature into DB
        await transactionModel.createAsync(
            signatures,
            approvalExpirationTimeSeconds,
            signedTransaction.signerAddress,
            coordinatorOrders,
            takerAssetFillAmounts,
        );

        return {
            signatures,
            expirationTimeSeconds: approvalExpirationTimeSeconds,
        };
    }
} // tslint:disable:max-file-line-count
