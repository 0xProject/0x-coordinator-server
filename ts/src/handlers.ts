import {
    ContractWrappers,
    DecodedCalldata,
    OrderAndTraderInfo,
    signatureUtils,
    transactionHashUtils,
    Web3ProviderEngine,
} from '0x.js';
import { orderUtils } from '@0x/asset-buyer/lib/src/utils/order_utils';
import { getContractAddressesForNetworkOrThrow } from '@0x/contract-addresses';
import { eip712Utils } from '@0x/order-utils';
import { Order, SignedOrder, SignedZeroExTransaction } from '@0x/types';
import { BigNumber, signTypedDataUtils } from '@0x/utils';
import * as express from 'express';
import * as HttpStatus from 'http-status-codes';
import * as _ from 'lodash';

import { constants } from './constants';
import { orderModel } from './models/order_model';
import { transactionModel } from './models/transaction_model';
import * as requestTransactionSchema from './schemas/request_transaction_schema.json';
import {
    BroadcastCallback,
    Configs,
    CoordinatorApproval,
    EventTypes,
    NetworkIdToContractWrappers,
    NetworkIdToProvider,
    RequestTransactionErrors,
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
            minSet.push(
                maxTakerAssetFillAmountGivenTakerConstraints,
                traderInfo.takerBalance,
                traderInfo.takerAllowance,
            );
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
                .integerValue(BigNumber.ROUND_CEIL); // Should this round to ciel or floor?
            minSet.push(maxTakerAssetFillAmountGivenTakerZRXConstraints);
        }

        // Calculate min of balance & allowance of maker's ZRX -> translate into takerAsset amount
        if (!signedOrder.makerFee.eq(0)) {
            const makerZRXAvailable = BigNumber.min(traderInfo.makerZrxBalance, traderInfo.makerZrxAllowance);
            const maxTakerAssetFillAmountGivenMakerZRXConstraints = makerZRXAvailable
                .multipliedBy(signedOrder.takerAssetAmount)
                .div(signedOrder.makerFee)
                .integerValue(BigNumber.ROUND_CEIL); // Should this round to ciel or floor?
            minSet.push(maxTakerAssetFillAmountGivenMakerZRXConstraints);
        }

        const remainingTakerAssetFillAmount = signedOrder.takerAssetAmount.minus(orderInfo.orderTakerAssetFilledAmount);
        minSet.push(remainingTakerAssetFillAmount);

        const maxTakerAssetFillAmount = BigNumber.min(...minSet);
        return maxTakerAssetFillAmount;
    }
    private static _getOrdersFromDecodedCallData(decodedCalldata: DecodedCalldata, networkId: number): Order[] {
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
                throw new Error(RequestTransactionErrors.InvalidFunctionCall);
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
                throw new Error(RequestTransactionErrors.FillRequestsExceededTakerAssetAmount);
            }

            // If cancelled, reject the request
            const isCancelled = await orderModel.isCancelledAsync(coordinatorOrder);
            if (isCancelled) {
                throw new Error(RequestTransactionErrors.OrderCancelled);
            }
        }
    }
    constructor(networkIdToProvider: NetworkIdToProvider, configs: Configs, broadcastCallback: BroadcastCallback) {
        this._networkIdToProvider = networkIdToProvider;
        this._broadcastCallback = broadcastCallback;
        this._configs = configs;
        this._networkIdToContractWrappers = {};
        _.each(networkIdToProvider, (provider: Web3ProviderEngine, networkIdStr: string) => {
            const contractWrappers = new ContractWrappers(provider, {
                networkId: _.parseInt(networkIdStr),
            });
            const networkId = _.parseInt(networkIdStr);
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
            res.status(HttpStatus.BAD_REQUEST).send(RequestTransactionErrors.DecodingTransactionFailed);
            return;
        }

        // 3. Check if at least one order in calldata has the Coordinator's feeRecipientAddress
        let orders: Order[] = [];
        try {
            orders = Handlers._getOrdersFromDecodedCallData(decodedCalldata, networkId);
        } catch (err) {
            res.status(HttpStatus.BAD_REQUEST).send(err.message);
            return;
        }
        const coordinatorOrders = _.filter(orders, order =>
            utils.isCoordinatorFeeRecipient(
                order.feeRecipientAddress,
                this._configs.NETWORK_ID_TO_SETTINGS[networkId].FEE_RECIPIENT_ADDRESS,
            ),
        );
        if (_.isEmpty(coordinatorOrders)) {
            res.status(HttpStatus.BAD_REQUEST).send(RequestTransactionErrors.CoordinatorFeeRecipientNotFound);
            return;
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
            case ExchangeMethods.MarketBuyOrdersNoThrow: {
                const takerAddress = signedTransaction.signerAddress;
                const takerAssetFillAmounts = await this._getTakerAssetFillAmountsFromDecodedCallDataAsync(
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
                        coordinatorSignature: response.body.signature,
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
                res.status(HttpStatus.BAD_REQUEST).send(RequestTransactionErrors.InvalidFunctionCall);
                return;
        }
    }
    private async _getTakerAssetFillAmountsFromDecodedCallDataAsync(
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
                // takerAssetFillAmounts
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
                throw new Error(RequestTransactionErrors.InvalidFunctionCall);
        }
        return takerAssetFillAmounts;
    }
    private async _handleCancelsAsync(
        coordinatorOrders: Order[],
        signedTransaction: SignedZeroExTransaction,
        networkId: number,
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
                orders: coordinatorOrders,
                zeroExTransaction: unsignedTransaction,
            },
        };
        this._broadcastCallback(cancelRequestAccepted, networkId);
        const outstandingSignatures = await transactionModel.getOutstandingSignaturesByOrdersAsync(coordinatorOrders);
        const body = {
            outstandingSignatures,
        };
        return {
            status: HttpStatus.OK,
            body,
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
        try {
            await Handlers._validateFillsAllowedOrThrowAsync(
                signedTransaction,
                coordinatorOrders,
                takerAssetFillAmounts,
            );
        } catch (err) {
            if (_.includes(_.values(RequestTransactionErrors), err.message)) {
                return {
                    status: HttpStatus.BAD_REQUEST,
                    body: err.message,
                };
            }
            throw err;
        }

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
        await utils.sleepAsync(this._configs.SELECTIVE_DELAY_MS); // Add selective delay

        // Check that still a valid fill request after selective delay
        try {
            await Handlers._validateFillsAllowedOrThrowAsync(
                signedTransaction,
                coordinatorOrders,
                takerAssetFillAmounts,
            );
        } catch (err) {
            if (_.includes(_.values(RequestTransactionErrors), err.message)) {
                return {
                    status: HttpStatus.BAD_REQUEST,
                    body: err.message,
                };
            }
            throw err;
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
        orders: Order[],
        takerAssetFillAmounts: BigNumber[],
        networkId: number,
    ): Promise<RequestTransactionResponse> {
        // generate signature & expiry and add to DB
        const approvalExpirationTimeSeconds =
            utils.getCurrentTimestampSeconds() + this._configs.EXPIRATION_DURATION_SECONDS;
        const transactionHash = transactionHashUtils.getTransactionHashHex(signedTransaction);
        const coordinatorApproval: CoordinatorApproval = {
            txOrigin,
            transactionHash,
            transactionSignature: signedTransaction.signature,
            approvalExpirationTimeSeconds,
        };
        const COORDINATOR_APPROVAL_SCHEMA = {
            name: 'CoordinatorApproval',
            parameters: [
                { name: 'txOrigin', type: 'address' },
                { name: 'transactionHash', type: 'bytes32' },
                { name: 'transactionSignature', type: 'bytes' },
                { name: 'approvalExpirationTimeSeconds', type: 'uint256' },
            ],
        };
        const normalizedCoordinatorApproval = _.mapValues(coordinatorApproval, value => {
            return !_.isString(value) ? value.toString() : value;
        });
        // TODO(fabio): Remove this hard-coding on the coordinator address once re-published contract-addresses
        // package
        // HACK(fabio): Hard-code fake Coordinator address until we've deployed the contract and added
        // the address to `@0x/contract-addresses`
        const contractAddresses = getContractAddressesForNetworkOrThrow(networkId);
        (contractAddresses as any).coordinator = constants.COORDINATOR_CONTRACT_ADDRESS;
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

        const provider = this._networkIdToProvider[networkId];
        const coordinatorApprovalECSignature = await signatureUtils.ecSignHashAsync(
            provider,
            coordinatorApprovalHashHex,
            this._configs.NETWORK_ID_TO_SETTINGS[networkId].FEE_RECIPIENT_ADDRESS,
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
            expirationTimeSeconds: approvalExpirationTimeSeconds,
        };
    }
} // tslint:disable:max-file-line-count
