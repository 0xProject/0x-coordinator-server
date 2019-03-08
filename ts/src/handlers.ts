import { ContractWrappers, DecodedCalldata, OrderAndTraderInfo, signatureUtils, transactionHashUtils } from '0x.js';
import { orderUtils } from '@0x/asset-buyer/lib/src/utils/order_utils';
import { getContractAddressesForNetworkOrThrow } from '@0x/contract-addresses';
import { eip712Utils } from '@0x/order-utils';
import { OrderWithoutExchangeAddress, SignedOrder, SignedZeroExTransaction } from '@0x/types';
import { BigNumber, signTypedDataUtils } from '@0x/utils';
import { Provider } from 'ethereum-types';
import * as express from 'express';
import * as HttpStatus from 'http-status-codes';
import * as _ from 'lodash';

import { getConfigs } from './configs';
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
    private readonly _provider: Provider;
    private readonly _broadcastCallback: BroadcastCallback;
    private readonly _contractWrappers: ContractWrappers;
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

            default:
                throw new Error(RequestTransactionErrors.InvalidFunctionCall);
        }
    }
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
    constructor(provider: Provider, broadcastCallback: BroadcastCallback) {
        this._provider = provider;
        this._broadcastCallback = broadcastCallback;
        this._contractWrappers = new ContractWrappers(provider, {
            networkId: getConfigs().NETWORK_ID,
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
            case ExchangeMethods.MarketBuyOrdersNoThrow: {
                const takerAddress = signedTransaction.signerAddress;
                const takerAssetFillAmounts = await this._getTakerAssetFillAmountsFromDecodedCallDataAsync(
                    decodedCalldata,
                    takerAddress,
                );
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
    private async _getTakerAssetFillAmountsFromDecodedCallDataAsync(
        decodedCalldata: DecodedCalldata,
        takerAddress: string,
    ): Promise<BigNumber[]> {
        const contractAddresses = getContractAddressesForNetworkOrThrow(getConfigs().NETWORK_ID);
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
                const orderAndTraderInfos = await this._contractWrappers.orderValidator.getOrdersAndTradersInfoAsync(
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
                const orderAndTraderInfos = await this._contractWrappers.orderValidator.getOrdersAndTradersInfoAsync(
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
        await utils.sleepAsync(configs.SELECTIVE_DELAY_MS); // Add selective delay
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
        const approvalExpirationTimeSeconds =
            utils.getCurrentTimestampSeconds() + getConfigs().EXPIRATION_DURATION_SECONDS;
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
        const contractAddresses = getContractAddressesForNetworkOrThrow(getConfigs().NETWORK_ID);
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
            getConfigs().FEE_RECIPIENT,
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
