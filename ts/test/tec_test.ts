import { CoordinatorContract, ERC20TokenContract } from '@0x/abi-gen-wrappers';
import { ContractAddresses, getContractAddressesForChainOrThrow } from '@0x/contract-addresses';
import { ContractWrappers } from '@0x/contract-wrappers';
import { DummyERC20TokenContract } from '@0x/contracts-erc20';
import { constants as testConstants, OrderFactory } from '@0x/contracts-test-utils';
import { BlockchainLifecycle, web3Factory } from '@0x/dev-utils';
import { runMigrationsOnceAsync } from '@0x/migrations';
import {
    assetDataUtils,
    orderCalculationUtils,
    orderHashUtils,
    SignatureType,
    transactionHashUtils,
} from '@0x/order-utils';
import { Web3ProviderEngine } from '@0x/subproviders';
import { SignedZeroExTransaction, ZeroExTransaction } from '@0x/types';
import { BigNumber, fetchAsync } from '@0x/utils';
import { Web3Wrapper } from '@0x/web3-wrapper';
import * as chai from 'chai';
import * as chaiAsPromised from 'chai-as-promised';
import ChaiBigNumber = require('chai-bignumber');
import * as dirtyChai from 'dirty-chai';
import * as ethUtil from 'ethereumjs-util';
import * as http from 'http';
import * as HttpStatus from 'http-status-codes';
import * as _ from 'lodash';
import 'mocha';
import * as request from 'supertest';
import * as WebSocket from 'websocket';

import { getAppAsync } from '../src/app';
import { assertConfigsAreValid } from '../src/assertions';
import { TakerAssetFillAmountEntity } from '../src/entities/taker_asset_fill_amount_entity';
import { TransactionEntity } from '../src/entities/transaction_entity';
import { GeneralErrorCodes, ValidationErrorCodes } from '../src/errors';
import { orderModel } from '../src/models/order_model';
import { transactionModel } from '../src/models/transaction_model';
import { CancelRequestAccepted, EventTypes, FillRequestReceivedEvent, NetworkSpecificSettings } from '../src/types';
import { utils } from '../src/utils';

import { FEE_RECIPIENT_ADDRESS_ONE, FEE_RECIPIENT_ADDRESS_TWO, TESTRPC_PRIVATE_KEYS_STRINGS } from './constants';
import { configs } from './test_configs';
import { TransactionFactory } from './transaction_factory';

chai.config.includeStack = true;
chai.use(ChaiBigNumber());
chai.use(dirtyChai);
chai.use(chaiAsPromised);
const expect = chai.expect;

assertConfigsAreValid(configs);

const TESTRPC_PRIVATE_KEYS = _.map(TESTRPC_PRIVATE_KEYS_STRINGS, privateKeyString =>
    ethUtil.toBuffer(privateKeyString),
);
const UNLIMITED_ALLOWANCE = new BigNumber(2).pow(256).minus(1);

let app: http.Server;

let web3Wrapper: Web3Wrapper;
let owner: string;
let makerAddress: string;
let takerAddress: string;
let feeRecipientAddress: string;
let makerTokenContract: DummyERC20TokenContract;
let takerTokenContract: DummyERC20TokenContract;
let transactionFactory: TransactionFactory;
let orderFactory: OrderFactory;
let provider: Web3ProviderEngine;
let accounts: string[];
let contractAddresses: ContractAddresses;
let blockchainLifecycle: BlockchainLifecycle;
let contractWrappers: ContractWrappers;

// Websocket tests only
const TEST_PORT = 8361;
const NETWORK_ID = 1337;
const WS_NOTIFICATION_ENDPOINT_PATH = `/v1/requests?networkId=${NETWORK_ID}`;
let wsClient: WebSocket.w3cwebsocket;

// Shared
const HTTP_REQUEST_TRANSACTION_ENDPOINT_PATH = `/v1/request_transaction?networkId=${NETWORK_ID}`;
const HTTP_REQUEST_TRANSACTION_URL = `http://127.0.0.1:${TEST_PORT}${HTTP_REQUEST_TRANSACTION_ENDPOINT_PATH}`;
const HTTP_SOFT_CANCELS_ENDPOINT_PATH = `/v1/soft_cancels?networkId=${NETWORK_ID}`;
const HTTP_CONFIG_ENDPOINT_PATH = `/v1/configuration`;
const DEFAULT_MAKER_TOKEN_ADDRESS = '0x34d402f14d58e001d8efbe6585051bf9706aa064';
const DEFAULT_TAKER_TOKEN_ADDRESS = '0x25b8fe1de9daf8ba351890744ff28cf7dfa8f5e3';
const NOT_COORDINATOR_FEE_RECIPIENT_ADDRESS = '0xb27ec3571c6abaa95db65ee7fec60fb694cbf822';

let defaultTransactionParams: ZeroExTransaction;

describe.only('Coordinator server', () => {
    before(async () => {
        const ganacheConfigs = {
            total_accounts: 10,
            shouldUseInProcessGanache: true,
            shouldAllowUnlimitedContractSize: true,
        };
        provider = web3Factory.getRpcProvider(ganacheConfigs);

        web3Wrapper = new Web3Wrapper(provider);
        blockchainLifecycle = new BlockchainLifecycle(web3Wrapper);

        await blockchainLifecycle.startAsync();
        accounts = await web3Wrapper.getAvailableAddressesAsync();
        [owner, makerAddress, takerAddress, feeRecipientAddress] = _.slice(accounts, 0, 6);
        await runMigrationsOnceAsync(provider, { from: owner });

        contractAddresses = getContractAddressesForChainOrThrow(NETWORK_ID);
        const settings: NetworkSpecificSettings = configs.NETWORK_ID_TO_SETTINGS[NETWORK_ID];
        if (feeRecipientAddress !== settings.FEE_RECIPIENTS[0].ADDRESS) {
            throw new Error(`Expected settings.FEE_RECIPEINTS[0].ADDRESS to be ${feeRecipientAddress}`);
        }

        contractWrappers = new ContractWrappers(provider, {
            chainId: NETWORK_ID,
        });

        const defaultOrderParams = {
            ...testConstants.STATIC_ORDER_PARAMS,
            makerAddress,
            feeRecipientAddress,
            makerAssetData: assetDataUtils.encodeERC20AssetData(DEFAULT_MAKER_TOKEN_ADDRESS),
            takerAssetData: assetDataUtils.encodeERC20AssetData(DEFAULT_TAKER_TOKEN_ADDRESS),
            makerFeeAssetData: assetDataUtils.encodeERC20AssetData(DEFAULT_MAKER_TOKEN_ADDRESS),
            takerFeeAssetData: assetDataUtils.encodeERC20AssetData(DEFAULT_TAKER_TOKEN_ADDRESS),
            exchangeAddress: contractAddresses.exchange,
            chainId: NETWORK_ID,
            senderAddress: contractAddresses.coordinator,
        };
        const makerPrivateKey = TESTRPC_PRIVATE_KEYS[accounts.indexOf(makerAddress)];
        orderFactory = new OrderFactory(makerPrivateKey, defaultOrderParams);
        const testOrder = await orderFactory.newSignedOrderAsync();
        const fillTestOrderCalldata = contractWrappers.exchange.fillOrder.getABIEncodedTransactionData(testOrder, new BigNumber(5), testOrder.signature);

        defaultTransactionParams = {
            salt: new BigNumber(
                '57466949743788259527933166264332732046478076361192368690875627090773188231774'),
            expirationTimeSeconds: new BigNumber(999999999),
            gasPrice: new BigNumber(1),
            signerAddress: '0xe834ec434daba538cd1b9fe1582052b880bd7e63',
            data: fillTestOrderCalldata,
             domain: {
                chainId: NETWORK_ID,
                verifyingContract: contractAddresses.coordinator,
            },
        };

        makerTokenContract = new DummyERC20TokenContract(DEFAULT_MAKER_TOKEN_ADDRESS, provider);
        takerTokenContract = new DummyERC20TokenContract(DEFAULT_TAKER_TOKEN_ADDRESS, provider);
    });
    after(async () => {
        await blockchainLifecycle.revertAsync();
    });
    beforeEach(async () => {
        await blockchainLifecycle.startAsync();

        const makerBalance = testConstants.STATIC_ORDER_PARAMS.makerAssetAmount.times(5);
        const makerAllowance = UNLIMITED_ALLOWANCE;
        const takerBalance = testConstants.STATIC_ORDER_PARAMS.takerAssetAmount.times(5);
        const takerAllowance = UNLIMITED_ALLOWANCE;
        await web3Wrapper.awaitTransactionSuccessAsync(
            await makerTokenContract.setBalance.sendTransactionAsync(makerAddress, makerBalance, {
                from: owner,
            }),
            testConstants.AWAIT_TRANSACTION_MINED_MS,
        );
        await web3Wrapper.awaitTransactionSuccessAsync(
            await makerTokenContract.approve.sendTransactionAsync(contractAddresses.erc20Proxy, makerAllowance, {
                from: makerAddress,
            }),
            testConstants.AWAIT_TRANSACTION_MINED_MS,
        );
        const zrxToken = new ERC20TokenContract(contractAddresses.zrxToken, provider);
        await web3Wrapper.awaitTransactionSuccessAsync(
            await zrxToken.transfer.sendTransactionAsync(makerAddress, makerBalance, { from: owner }),
            testConstants.AWAIT_TRANSACTION_MINED_MS,
        );
        await web3Wrapper.awaitTransactionSuccessAsync(
            await zrxToken.approve.sendTransactionAsync(contractAddresses.erc20Proxy, UNLIMITED_ALLOWANCE, {
                from: makerAddress,
            }),
            testConstants.AWAIT_TRANSACTION_MINED_MS,
        );
        await web3Wrapper.awaitTransactionSuccessAsync(
            await takerTokenContract.setBalance.sendTransactionAsync(takerAddress, takerBalance, {
                from: owner,
            }),
            testConstants.AWAIT_TRANSACTION_MINED_MS,
        );
        await web3Wrapper.awaitTransactionSuccessAsync(
            await takerTokenContract.approve.sendTransactionAsync(contractAddresses.erc20Proxy, takerAllowance, {
                from: takerAddress,
            }),
            testConstants.AWAIT_TRANSACTION_MINED_MS,
        );
        await web3Wrapper.awaitTransactionSuccessAsync(
            await zrxToken.transfer.sendTransactionAsync(takerAddress, takerBalance, { from: owner }),
            testConstants.AWAIT_TRANSACTION_MINED_MS,
        );
        await web3Wrapper.awaitTransactionSuccessAsync(
            await zrxToken.approve.sendTransactionAsync(contractAddresses.erc20Proxy, UNLIMITED_ALLOWANCE, {
                from: takerAddress,
            }),
            testConstants.AWAIT_TRANSACTION_MINED_MS,
        );
    });
    afterEach(async () => {
        await blockchainLifecycle.revertAsync();
    });
    describe('#/v1/configuration', () => {
        before(async () => {
            app = await getAppAsync(
                {
                    [NETWORK_ID]: provider,
                },
                configs,
            );
        });
        it('should return coordinator configuration', async () => {
            const response = await request(app).get(HTTP_CONFIG_ENDPOINT_PATH);
            expect(response.status).to.be.equal(HttpStatus.OK);
            expect(response.body.expirationDurationSeconds).to.be.equal(configs.EXPIRATION_DURATION_SECONDS);
            expect(response.body.selectiveDelayMs).to.be.equal(configs.SELECTIVE_DELAY_MS);
            expect(response.body.supportedNetworkIds).to.be.instanceOf(Array);
            expect(response.body.supportedNetworkIds).to.have.length(1);
            expect(response.body.supportedNetworkIds[0]).to.be.equal(NETWORK_ID);
        });
    });
    describe('#/v1/request_transaction', () => {
        before(async () => {
            app = await getAppAsync(
                {
                    [NETWORK_ID]: provider,
                },
                configs,
            );
        });
        it('should return 400 Bad Request if request body does not conform to schema', async () => {
            const invalidBody = {
                signedTransaction: {
                    // Missing signerAddress
                    salt: new BigNumber(
                        '10798369788836331947878244228295394663118854512666292664573150674534689981547',
                    ),
                    data:
                        '0xb4be83d500000000000000000000000000000000000000000000000000000000000000600000000000000000000000000000000000000000000000056bc75e2d6310000000000000000000000000000000000000000000000000000000000000000002a0000000000000000000000000e36ea790bc9d7ab70c55260c66d52b1eca985f84000000000000000000000000000000000000000000000000000000000000000000000000000000000000000078dc5d2d739606d31509c31d654056a45185ecb60000000000000000000000006ecbe1db9ef729cbe972c83fb886247691fb6beb0000000000000000000000000000000000000000000000056bc75e2d6310000000000000000000000000000000000000000000000000000ad78ebc5ac62000000000000000000000000000000000000000000000000000000de0b6b3a76400000000000000000000000000000000000000000000000000000de0b6b3a7640000000000000000000000000000000000000000000000000000000000005c5f2b93a6902335d6d05d92895df0a8c381bfc14c342d58df4f926ee938fa1871677f7c000000000000000000000000000000000000000000000000000000000000018000000000000000000000000000000000000000000000000000000000000001e00000000000000000000000000000000000000000000000000000000000000024f47261b00000000000000000000000001e2f9e10d02a6b8f8f69fcbf515e75039d2ea30d000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000024f47261b0000000000000000000000000be0037eaf2d64fe5529bca93c18c9702d39303760000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000421b1b52aa1994a139883072845a049e4bfda827a5ab435a7f417e37c7bc18663362306d5a9e50f8aa110330987731be51dbfe69a2a0de2c4103da79dbb42b3070b203000000000000000000000000000000000000000000000000000000000000',
                    verifyingContractAddress: contractAddresses.coordinator,
                    signature:
                        '0x1cc0b3a07c8bd0346e8ad34278beb28f5b90720ccfde3fe761333971e2b130abd75546534e8d8f0b476c201c573ffeb0c24ed2753ba70e4fe68820075b5eaf1a0003',
                },
            };
            const response = await request(app)
                .post(HTTP_REQUEST_TRANSACTION_ENDPOINT_PATH)
                .send(invalidBody);
            expect(response.status).to.be.equal(HttpStatus.BAD_REQUEST);
            expect(response.body.code).to.be.equal(GeneralErrorCodes.ValidationError);
            expect(response.body.validationErrors[0].code).to.be.equal(ValidationErrorCodes.RequiredField);
            expect(response.body.validationErrors[0].field).to.be.equal('signerAddress');
        });
        it('should return 400 Bad Request if signature is invalid', async () => {
            const invalidSignature = '0x1b73ae1c93d58da1162dcf896111afce37439f1f24adcbeb7a9c7407920a3bd3010fad757de911d8b5e1067dd210aca35a027dd154a0167c4a15278af22904b70b03';
            const invalidBody = {
                signedTransaction: {
                    ...defaultTransactionParams,
                    signature: invalidSignature
                }
            };
            const response = await request(app)
                .post(HTTP_REQUEST_TRANSACTION_ENDPOINT_PATH)
                .send(invalidBody);
            console.log(JSON.stringify(response, null, 4));
            expect(response.status).to.be.equal(HttpStatus.BAD_REQUEST);
            expect(response.body.code).to.be.equal(GeneralErrorCodes.ValidationError);
            expect(response.body.validationErrors[0].code).to.be.equal(
                ValidationErrorCodes.InvalidZeroExTransactionSignature,
            );
        });
        it('should return 400 INVALID_FEE_RECIPIENT. if transaction sent with order without Coordinators feeRecipientAddress', async () => {
            const order = await orderFactory.newSignedOrderAsync({
                feeRecipientAddress: NOT_COORDINATOR_FEE_RECIPIENT_ADDRESS,
            });
            const takerAssetFillAmount = order.takerAssetAmount.div(2);
            const data = contractWrappers.exchange.fillOrder.getABIEncodedTransactionData(
                order,
                takerAssetFillAmount,
                order.signature,
            );
            const signedTransaction = createSignedTransaction(data, takerAddress);
            const body = {
                signedTransaction,
                txOrigin: takerAddress,
            };
            const response = await request(app)
                .post(HTTP_REQUEST_TRANSACTION_ENDPOINT_PATH)
                .send(body);
            expect(response.status).to.be.equal(HttpStatus.BAD_REQUEST);
            expect(response.body.code).to.be.equal(GeneralErrorCodes.ValidationError);
            expect(response.body.validationErrors[0].code).to.be.equal(
                ValidationErrorCodes.NoCoordinatorOrdersIncluded,
            );
        });
        it('should return 400 if transaction cannot be decoded', async () => {
            const invalidData =
                '0xa4be84d500000000000000000000000000000000000000000000000000000000000000600000000000000000000000000000000000000000000000056bc75e2d6310000000000000000000000000000000000000000000000000000000000000000002a0000000000000000000000000e36ea790bc9d7ab70c55260c66d52b1eca985f84000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000006ecbe1db9ef729cbe972c83fb886247691fb6beb0000000000000000000000000000000000000000000000056bc75e2d6310000000000000000000000000000000000000000000000000000ad78ebc5ac62000000000000000000000000000000000000000000000000000000de0b6b3a76400000000000000000000000000000000000000000000000000000de0b6b3a7640000000000000000000000000000000000000000000000000000000000005c60629ac12f9da01839cabc64cb7d0ddeee4bdda46e6b9b00f66cb469d57bcd871fb6fb000000000000000000000000000000000000000000000000000000000000018000000000000000000000000000000000000000000000000000000000000001e00000000000000000000000000000000000000000000000000000000000000024f47261b00000000000000000000000001e2f9e10d02a6b8f8f69fcbf515e75039d2ea30d000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000024f47261b0000000000000000000000000be0037eaf2d64fe5529bca93c18c9702d39303760000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000421c45cd8e03845be9c5878cd2fec5ae2b75ff36de4ff331680d4e6cca57c8b9d38f2ad9af72e5f56f3c2da6eff57373dca43122642c5fa29d0a83b4f63f413c083a03000000000000000000000000000000000000000000000000000000000000';
            const signedTransaction = createSignedTransaction(invalidData, takerAddress);
            const body = {
                signedTransaction,
                txOrigin: takerAddress,
            };
            const response = await request(app)
                .post(HTTP_REQUEST_TRANSACTION_ENDPOINT_PATH)
                .send(body);
            expect(response.status).to.be.equal(HttpStatus.BAD_REQUEST);
            expect(response.body.code).to.be.equal(GeneralErrorCodes.ValidationError);
            expect(response.body.validationErrors[0].code).to.be.equal(
                ValidationErrorCodes.ZeroExTransactionDecodingFailed,
            );
        });
        it('should return 400 if batch cancellation transaction not signed by order maker', async () => {
            const order = await orderFactory.newSignedOrderAsync();
            const data = contractWrappers.exchange.batchCancelOrders.getABIEncodedTransactionData([order]);
            const notMakerAddress = takerAddress;
            const signedTransaction = createSignedTransaction(data, notMakerAddress);
            const body = {
                signedTransaction,
                txOrigin: notMakerAddress,
            };
            const response = await request(app)
                .post(HTTP_REQUEST_TRANSACTION_ENDPOINT_PATH)
                .send(body);
            expect(response.status).to.be.equal(HttpStatus.BAD_REQUEST);
            expect(response.body.code).to.be.equal(GeneralErrorCodes.ValidationError);
            expect(response.body.validationErrors[0].code).to.be.equal(ValidationErrorCodes.OnlyMakerCanCancelOrders);
        });
        it.only('should return 200 and only cancel Coordinator order if only one order sent in batch cancellation is a Coordinator order', async () => {
            const coordinatorOrder = await orderFactory.newSignedOrderAsync();
            const notCoordinatorOrder = await orderFactory.newSignedOrderAsync({
                feeRecipientAddress: NOT_COORDINATOR_FEE_RECIPIENT_ADDRESS,
            });
            const data = contractWrappers.exchange.batchCancelOrders.getABIEncodedTransactionData([
                coordinatorOrder,
                notCoordinatorOrder,
            ]);
            const signedTransaction = createSignedTransaction(data, makerAddress);
            const body = {
                signedTransaction,
                txOrigin: makerAddress,
            };
            const response = await request(app)
                .post(HTTP_REQUEST_TRANSACTION_ENDPOINT_PATH)
                .send(body);
            expect(response.status).to.be.equal(HttpStatus.OK);
            expect(response.body.outstandingFillSignatures).to.be.instanceOf(Array);
            expect(response.body.outstandingFillSignatures.length).to.be.equal(0);
            expect(response.body.cancellationSignatures.length).to.be.equal(1);

            // Check that only the Coordinator order got cancelled in DB
            let isSoftCancelled = await orderModel.isSoftCancelledAsync(coordinatorOrder);
            expect(isSoftCancelled).to.be.true();
            isSoftCancelled = await orderModel.isSoftCancelledAsync(notCoordinatorOrder);
            expect(isSoftCancelled).to.be.false();
        });
        it('should return 200 OK & mark order as cancelled if successfully batch cancelling orders', async () => {
            const orderOne = await orderFactory.newSignedOrderAsync();
            const orderTwo = await orderFactory.newSignedOrderAsync();
            const data = contractWrappers.exchange.batchCancelOrders.getABIEncodedTransactionData([orderOne, orderTwo]);
            const signedTransaction = createSignedTransaction(data, makerAddress);
            const body = {
                signedTransaction,
                txOrigin: makerAddress,
            };
            const response = await request(app)
                .post(HTTP_REQUEST_TRANSACTION_ENDPOINT_PATH)
                .send(body);
            expect(response.status).to.be.equal(HttpStatus.OK);
            expect(response.body.outstandingFillSignatures).to.be.instanceOf(Array);
            expect(response.body.outstandingFillSignatures.length).to.be.equal(0);
            expect(response.body.cancellationSignatures.length).to.be.equal(1);

            // Check that orders cancelled in DB
            let isSoftCancelled = await orderModel.isSoftCancelledAsync(orderOne);
            expect(isSoftCancelled).to.be.true();
            isSoftCancelled = await orderModel.isSoftCancelledAsync(orderTwo);
            expect(isSoftCancelled).to.be.true();
        });
        it('should return 200 OK if request to batchCancel 2 orders each with a different, supported feeRecipientAddress', async () => {
            const orderOne = await orderFactory.newSignedOrderAsync({
                feeRecipientAddress: FEE_RECIPIENT_ADDRESS_ONE,
            });
            const orderTwo = await orderFactory.newSignedOrderAsync({
                feeRecipientAddress: FEE_RECIPIENT_ADDRESS_TWO,
            });
            const data = contractWrappers.exchange.batchCancelOrders.getABIEncodedTransactionData([orderOne, orderTwo]);
            const signedTransaction = createSignedTransaction(data, makerAddress);
            const body = {
                signedTransaction,
                txOrigin: makerAddress,
            };
            const response = await request(app)
                .post(HTTP_REQUEST_TRANSACTION_ENDPOINT_PATH)
                .send(body);
            expect(response.status).to.be.equal(HttpStatus.OK);
            expect(response.body.outstandingFillSignatures).to.be.instanceOf(Array);
            expect(response.body.outstandingFillSignatures.length).to.be.equal(0);
            expect(response.body.cancellationSignatures.length).to.be.equal(2);

            // Check that orders cancelled in DB
            let isSoftCancelled = await orderModel.isSoftCancelledAsync(orderOne);
            expect(isSoftCancelled).to.be.true();
            isSoftCancelled = await orderModel.isSoftCancelledAsync(orderTwo);
            expect(isSoftCancelled).to.be.true();
        });
        it('should return 400 and leave order uncancelled if non-maker tried to cancel an order', async () => {
            const order = await orderFactory.newSignedOrderAsync();
            const data = contractWrappers.exchange.cancelOrder.getABIEncodedTransactionData(order);
            const notMakerAddress = owner;
            const signedTransaction = createSignedTransaction(data, notMakerAddress);
            const body = {
                signedTransaction,
                txOrigin: notMakerAddress,
            };
            const response = await request(app)
                .post(HTTP_REQUEST_TRANSACTION_ENDPOINT_PATH)
                .send(body);
            expect(response.status).to.be.equal(HttpStatus.BAD_REQUEST);
            expect(response.body.code).to.be.equal(GeneralErrorCodes.ValidationError);
            expect(response.body.validationErrors[0].code).to.be.equal(ValidationErrorCodes.OnlyMakerCanCancelOrders);

            // Verify that order wasn't cancelled
            const isSoftCancelled = await orderModel.isSoftCancelledAsync(order);
            expect(isSoftCancelled).to.be.false();
        });
        it('should return 200 OK & mark order as cancelled if successfully cancelling an order', async () => {
            const order = await orderFactory.newSignedOrderAsync();
            const cancelData = contractWrappers.exchange.cancelOrder.getABIEncodedTransactionData(order);
            const signedTransaction = createSignedTransaction(cancelData, makerAddress);
            const body = {
                signedTransaction,
                txOrigin: makerAddress,
            };
            const response = await request(app)
                .post(HTTP_REQUEST_TRANSACTION_ENDPOINT_PATH)
                .send(body);
            expect(response.status).to.be.equal(HttpStatus.OK);
            expect(response.body.outstandingFillSignatures).to.be.instanceOf(Array);
            expect(response.body.outstandingFillSignatures.length).to.be.equal(0);
            expect(response.body.cancellationSignatures.length).to.be.equal(1);

            // Check that order cancelled in DB
            const isSoftCancelled = await orderModel.isSoftCancelledAsync(order);
            expect(isSoftCancelled).to.be.true();

            // Check that someone trying to fill the order, can't
            const takerAssetFillAmount = order.takerAssetAmount.div(2);
            const fillData = contractWrappers.exchange.fillOrder.getABIEncodedTransactionData(
                order,
                takerAssetFillAmount,
                order.signature,
            );
            const signedFillTransaction = createSignedTransaction(fillData, takerAddress);
            const fillBody = {
                signedTransaction: signedFillTransaction,
                txOrigin: takerAddress,
            };
            const fillResponse = await request(app)
                .post(HTTP_REQUEST_TRANSACTION_ENDPOINT_PATH)
                .send(fillBody);
            expect(fillResponse.status).to.be.equal(HttpStatus.BAD_REQUEST);
            expect(fillResponse.body.code).to.be.equal(GeneralErrorCodes.ValidationError);
            expect(fillResponse.body.validationErrors[0].code).to.be.equal(
                ValidationErrorCodes.IncludedOrderAlreadySoftCancelled,
            );
            const orderHash = orderHashUtils.getOrderHashHex(order);
            expect(fillResponse.body.validationErrors[0].entities).to.be.deep.equal([orderHash]);
        });
        it('should return 200 OK to order cancellation request & return outstandingFillSignatures', async () => {
            const order = await orderFactory.newSignedOrderAsync();

            // Request to fill order
            const takerAssetFillAmount = order.takerAssetAmount.div(2);
            const data = contractWrappers.exchange.fillOrder.getABIEncodedTransactionData(
                order,
                takerAssetFillAmount,
                order.signature,
            );
            const signedTransaction = createSignedTransaction(data, takerAddress);
            let body = {
                signedTransaction,
                txOrigin: takerAddress,
            };
            const fillResponse = await request(app)
                .post(HTTP_REQUEST_TRANSACTION_ENDPOINT_PATH)
                .send(body);
            expect(fillResponse.status).to.be.equal(HttpStatus.OK);

            // Once fill request granted, request to cancel order
            const cancelData = contractWrappers.exchange.cancelOrder.getABIEncodedTransactionData(order);
            const signedCancelTransaction = createSignedTransaction(cancelData, makerAddress);
            body = {
                signedTransaction: signedCancelTransaction,
                txOrigin: makerAddress,
            };
            const response = await request(app)
                .post(HTTP_REQUEST_TRANSACTION_ENDPOINT_PATH)
                .send(body);
            expect(response.status).to.be.equal(HttpStatus.OK);
            expect(response.body.outstandingFillSignatures).to.be.instanceOf(Array);
            expect(response.body.outstandingFillSignatures.length).to.be.equal(1);
            expect(response.body.outstandingFillSignatures[0].approvalSignatures[0]).to.be.equal(
                fillResponse.body.signatures[0],
            );
            expect(response.body.outstandingFillSignatures[0].expirationTimeSeconds).to.be.equal(
                fillResponse.body.expirationTimeSeconds,
            );
            expect(response.body.outstandingFillSignatures[0].takerAssetFillAmount).to.be.bignumber.equal(
                takerAssetFillAmount,
            );
            expect(response.body.cancellationSignatures.length).to.be.equal(1);
        });
        it('should return 400 if request specifies unsupported networkId', async () => {
            const order = await orderFactory.newSignedOrderAsync();
            const takerAssetFillAmount = order.takerAssetAmount.div(2);
            const data = contractWrappers.exchange.fillOrder.getABIEncodedTransactionData(
                order,
                takerAssetFillAmount,
                order.signature,
            );
            const signedTransaction = createSignedTransaction(data, takerAddress);
            const txOrigin = takerAddress;
            const body = {
                signedTransaction,
                txOrigin,
            };
            const response = await request(app)
                .post('/v1/request_transaction?networkId=999')
                .send(body);
            expect(response.status).to.be.equal(HttpStatus.BAD_REQUEST);
            expect(response.body.code).to.be.equal(GeneralErrorCodes.ValidationError);
            expect(response.body.validationErrors[0].code).to.be.equal(ValidationErrorCodes.UnsupportedOption);
            expect(response.body.validationErrors[0].field).to.be.equal('networkId');
        });
        it('should return 200 OK if request to batchFill 2 orders each with a different, supported feeRecipientAddress', async () => {
            const orderOne = await orderFactory.newSignedOrderAsync({
                feeRecipientAddress: FEE_RECIPIENT_ADDRESS_ONE,
            });
            const orderTwo = await orderFactory.newSignedOrderAsync({
                feeRecipientAddress: FEE_RECIPIENT_ADDRESS_TWO,
            });
            const takerAssetFillAmountOne = orderOne.takerAssetAmount;
            const takerAssetFillAmountTwo = orderTwo.takerAssetAmount;
            const data = contractWrappers.exchange.batchFillOrders.getABIEncodedTransactionData(
                [orderOne, orderTwo],
                [takerAssetFillAmountOne, takerAssetFillAmountTwo],
                [orderOne.signature, orderTwo.signature],
            );
            const signedTransaction = createSignedTransaction(data, takerAddress);
            const txOrigin = takerAddress;
            const body = {
                signedTransaction,
                txOrigin,
            };
            const response = await request(app)
                .post(HTTP_REQUEST_TRANSACTION_ENDPOINT_PATH)
                .send(body);
            expect(response.status).to.be.equal(HttpStatus.OK);
            expect(response.body.signatures).to.not.be.undefined();
            expect(response.body.signatures.length).to.be.equal(2);
            const currTimestamp = utils.getCurrentTimestampSeconds();
            expect(response.body.expirationTimeSeconds).to.be.greaterThan(currTimestamp);

            // Check that fill request was added to DB
            const transactionEntityIfExists = await transactionModel.findAsync(
                takerAddress,
                JSON.stringify(response.body.signatures),
            );
            expect(transactionEntityIfExists).to.not.be.undefined();
            expect((transactionEntityIfExists as TransactionEntity).expirationTimeSeconds).to.be.equal(
                response.body.expirationTimeSeconds,
            );
            expect((transactionEntityIfExists as TransactionEntity).takerAssetFillAmounts.length).to.equal(2);
            expect(
                (transactionEntityIfExists as TransactionEntity).takerAssetFillAmounts[0].takerAssetFillAmount,
            ).to.be.bignumber.equal(takerAssetFillAmountOne);
            expect(
                (transactionEntityIfExists as TransactionEntity).takerAssetFillAmounts[1].takerAssetFillAmount,
            ).to.be.bignumber.equal(takerAssetFillAmountTwo);
        });
        it('should return 200 OK if request to fill uncancelled order', async () => {
            const order = await orderFactory.newSignedOrderAsync();
            const takerAssetFillAmount = order.takerAssetAmount.div(2);
            const data = contractWrappers.exchange.fillOrder.getABIEncodedTransactionData(
                order,
                takerAssetFillAmount,
                order.signature,
            );
            const signedTransaction = createSignedTransaction(data, takerAddress);
            const txOrigin = takerAddress;
            const body = {
                signedTransaction,
                txOrigin,
            };
            const response = await request(app)
                .post(HTTP_REQUEST_TRANSACTION_ENDPOINT_PATH)
                .send(body);
            expect(response.status).to.be.equal(HttpStatus.OK);
            expect(response.body.signatures).to.not.be.undefined();
            expect(response.body.signatures.length).to.be.equal(1);
            const currTimestamp = utils.getCurrentTimestampSeconds();
            expect(response.body.expirationTimeSeconds).to.be.greaterThan(currTimestamp);

            // Check that fill request was added to DB
            const transactionEntityIfExists = await transactionModel.findAsync(
                takerAddress,
                JSON.stringify(response.body.signatures),
            );
            expect(transactionEntityIfExists).to.not.be.undefined();
            expect((transactionEntityIfExists as TransactionEntity).expirationTimeSeconds).to.be.equal(
                response.body.expirationTimeSeconds,
            );
            expect((transactionEntityIfExists as TransactionEntity).takerAssetFillAmounts.length).to.equal(1);
            expect(
                (transactionEntityIfExists as TransactionEntity).takerAssetFillAmounts[0].takerAssetFillAmount,
            ).to.be.bignumber.equal(takerAssetFillAmount);

            const coordinatorContract = new CoordinatorContract(contractAddresses.coordinator, provider);

            await web3Wrapper.awaitTransactionSuccessAsync(
                await coordinatorContract.executeTransaction.sendTransactionAsync(
                    signedTransaction,
                    txOrigin,
                    signedTransaction.signature,
                    [response.body.expirationTimeSeconds],
                    [response.body.signatures[0]],
                    {
                        from: takerAddress,
                    },
                ),
                testConstants.AWAIT_TRANSACTION_MINED_MS,
            );
        });
        it('should return 200 OK if request to marketSellOrdersNoThrow uncancelled orders', async () => {
            const orderOne = await orderFactory.newSignedOrderAsync();
            const orderTwo = await orderFactory.newSignedOrderAsync();
            // 1.5X the total fillAmount of the two orders
            const orderOneTakerAssetFillAmount = orderOne.takerAssetAmount;
            const orderTwoTakerAssetFillAmount = orderTwo.takerAssetAmount.div(2);
            const takerAssetFillAmount = orderOneTakerAssetFillAmount.plus(orderTwoTakerAssetFillAmount);
            const data = contractWrappers.exchange.marketSellOrdersNoThrow.getABIEncodedTransactionData(
                [orderOne, orderTwo],
                takerAssetFillAmount,
                [orderOne.signature, orderTwo.signature],
            );
            const signedTransaction = createSignedTransaction(data, takerAddress);
            const body = {
                signedTransaction,
                txOrigin: takerAddress,
            };
            const response = await request(app)
                .post(HTTP_REQUEST_TRANSACTION_ENDPOINT_PATH)
                .send(body);
            expect(response.status).to.be.equal(HttpStatus.OK);
            expect(response.body.signatures).to.not.be.undefined();
            expect(response.body.signatures.length).to.be.equal(1);
            const currTimestamp = utils.getCurrentTimestampSeconds();
            expect(response.body.expirationTimeSeconds).to.be.greaterThan(currTimestamp);

            // Check that fill request was added to DB
            const transactionEntityIfExists = await transactionModel.findAsync(
                takerAddress,
                JSON.stringify(response.body.signatures),
            );
            expect(transactionEntityIfExists).to.not.be.undefined();
            expect((transactionEntityIfExists as TransactionEntity).expirationTimeSeconds).to.be.equal(
                response.body.expirationTimeSeconds,
            );
            expect((transactionEntityIfExists as TransactionEntity).takerAssetFillAmounts.length).to.equal(2);

            // Check that the correct takerAssetFillAmounts were calculated and stored
            const orderHashOne = orderHashUtils.getOrderHashHex(orderOne);
            const takerAssetFillAmountOne = _.find(
                (transactionEntityIfExists as TransactionEntity).takerAssetFillAmounts,
                t => t.orderHash === orderHashOne,
            ) as TakerAssetFillAmountEntity;
            expect(takerAssetFillAmountOne.takerAssetFillAmount).to.be.bignumber.equal(orderOneTakerAssetFillAmount);

            const orderHashTwo = orderHashUtils.getOrderHashHex(orderTwo);
            const takerAssetFillAmountTwo = _.find(
                (transactionEntityIfExists as TransactionEntity).takerAssetFillAmounts,
                t => t.orderHash === orderHashTwo,
            ) as TakerAssetFillAmountEntity;
            expect(takerAssetFillAmountTwo.takerAssetFillAmount).to.be.bignumber.equal(orderTwoTakerAssetFillAmount);
        });
        it('should return 200 OK if request to marketBuy uncancelled orders', async () => {
            const orderOne = await orderFactory.newSignedOrderAsync();
            const orderTwo = await orderFactory.newSignedOrderAsync();
            // 1.5X the total fillAmount of the two orders
            const orderOneMakerAssetFillAmount = orderOne.makerAssetAmount;
            const orderTwoMakerAssetFillAmount = orderTwo.makerAssetAmount.div(2);
            const makerAssetFillAmount = orderOneMakerAssetFillAmount.plus(orderTwoMakerAssetFillAmount);
            const data = contractWrappers.exchange.marketBuyOrdersNoThrow.getABIEncodedTransactionData(
                [orderOne, orderTwo],
                makerAssetFillAmount,
                [orderOne.signature, orderTwo.signature],
            );
            const signedTransaction = createSignedTransaction(data, takerAddress);
            const body = {
                signedTransaction,
                txOrigin: takerAddress,
            };
            const response = await request(app)
                .post(HTTP_REQUEST_TRANSACTION_ENDPOINT_PATH)
                .send(body);
            expect(response.status).to.be.equal(HttpStatus.OK);
            expect(response.body.signatures).to.not.be.undefined();
            expect(response.body.signatures.length).to.be.equal(1);
            const currTimestamp = utils.getCurrentTimestampSeconds();
            expect(response.body.expirationTimeSeconds).to.be.greaterThan(currTimestamp);

            // Check that fill request was added to DB
            const transactionEntityIfExists = await transactionModel.findAsync(
                takerAddress,
                JSON.stringify(response.body.signatures),
            );
            expect(transactionEntityIfExists).to.not.be.undefined();
            expect((transactionEntityIfExists as TransactionEntity).expirationTimeSeconds).to.be.equal(
                response.body.expirationTimeSeconds,
            );
            expect((transactionEntityIfExists as TransactionEntity).takerAssetFillAmounts.length).to.equal(2);

            // Check that the correct takerAssetFillAmounts were calculated and stored
            const orderHashOne = orderHashUtils.getOrderHashHex(orderOne);
            const takerAssetFillAmountOne = _.find(
                (transactionEntityIfExists as TransactionEntity).takerAssetFillAmounts,
                t => t.orderHash === orderHashOne,
            ) as TakerAssetFillAmountEntity;
            const expectedOrderOneMakerAssetFillAmount = orderCalculationUtils.getMakerFillAmount(
                orderOne,
                takerAssetFillAmountOne.takerAssetFillAmount,
            );
            expect(expectedOrderOneMakerAssetFillAmount).to.be.bignumber.equal(orderOneMakerAssetFillAmount);

            const orderHashTwo = orderHashUtils.getOrderHashHex(orderTwo);
            const takerAssetFillAmountTwo = _.find(
                (transactionEntityIfExists as TransactionEntity).takerAssetFillAmounts,
                t => t.orderHash === orderHashTwo,
            ) as TakerAssetFillAmountEntity;
            const expectedOrderTwoMakerAssetFillAmount = orderCalculationUtils.getMakerFillAmount(
                orderOne,
                takerAssetFillAmountTwo.takerAssetFillAmount,
            );
            expect(expectedOrderTwoMakerAssetFillAmount).to.be.bignumber.equal(orderTwoMakerAssetFillAmount);
        });
        it('should return 400 TRANSACTION_ALREADY_USED if request same 0x transaction multiple times', async () => {
            const order = await orderFactory.newSignedOrderAsync();
            const takerAssetFillAmount = order.takerAssetAmount; // Full amount
            const data = contractWrappers.exchange.fillOrder.getABIEncodedTransactionData(
                order,
                takerAssetFillAmount,
                order.signature,
            );
            const signedTransaction = createSignedTransaction(data, takerAddress);
            const body = {
                signedTransaction,
                txOrigin: takerAddress,
            };
            let response = await request(app)
                .post(HTTP_REQUEST_TRANSACTION_ENDPOINT_PATH)
                .send(body);
            expect(response.status).to.be.equal(HttpStatus.OK);
            expect(response.body.signatures).to.not.be.undefined();
            expect(response.body.signatures.length).to.be.equal(1);
            const currTimestamp = utils.getCurrentTimestampSeconds();
            expect(response.body.expirationTimeSeconds).to.be.greaterThan(currTimestamp);

            response = await request(app)
                .post(HTTP_REQUEST_TRANSACTION_ENDPOINT_PATH)
                .send(body);
            expect(response.status).to.be.equal(HttpStatus.BAD_REQUEST);
            expect(response.body.code).to.be.equal(GeneralErrorCodes.ValidationError);
            expect(response.body.validationErrors[0].code).to.be.equal(ValidationErrorCodes.TransactionAlreadyUsed);
        });
        it('should return 400 FILL_REQUESTS_EXCEEDED_TAKER_ASSET_AMOUNT if request to fill an order multiple times fully', async () => {
            const order = await orderFactory.newSignedOrderAsync();
            const takerAssetFillAmount = order.takerAssetAmount; // Full amount
            const dataOne = contractWrappers.exchange.fillOrder.getABIEncodedTransactionData(
                order,
                takerAssetFillAmount,
                order.signature,
            );
            const signedTransactionOne = createSignedTransaction(dataOne, takerAddress);
            let body = {
                signedTransaction: signedTransactionOne,
                txOrigin: takerAddress,
            };
            let response = await request(app)
                .post(HTTP_REQUEST_TRANSACTION_ENDPOINT_PATH)
                .send(body);
            expect(response.status).to.be.equal(HttpStatus.OK);
            expect(response.body.signatures).to.not.be.undefined();
            expect(response.body.signatures.length).to.be.equal(1);
            const currTimestamp = utils.getCurrentTimestampSeconds();
            expect(response.body.expirationTimeSeconds).to.be.greaterThan(currTimestamp);

            const dataTwo = contractWrappers.exchange.fillOrder.getABIEncodedTransactionData(
                order,
                takerAssetFillAmount,
                order.signature,
            );
            const signedTransactionTwo = createSignedTransaction(dataTwo, takerAddress);
            body = {
                signedTransaction: signedTransactionTwo,
                txOrigin: takerAddress,
            };
            response = await request(app)
                .post(HTTP_REQUEST_TRANSACTION_ENDPOINT_PATH)
                .send(body);
            expect(response.status).to.be.equal(HttpStatus.BAD_REQUEST);
            expect(response.body.code).to.be.equal(GeneralErrorCodes.ValidationError);
            expect(response.body.validationErrors[0].code).to.be.equal(
                ValidationErrorCodes.FillRequestsExceededTakerAssetAmount,
            );
            const orderHash = orderHashUtils.getOrderHashHex(order);
            expect(response.body.validationErrors[0].entities).to.be.deep.equal([orderHash]);
        });
    });
    describe('With selective delay', () => {
        before(async () => {
            const configWithDelay = {
                ...configs,
                SELECTIVE_DELAY_MS: 1000,
            };
            app = await getAppAsync(
                {
                    [NETWORK_ID]: provider,
                },
                configWithDelay,
            );
        });
        it('should abort fill request if cancellation received during selective delay', done => {
            // tslint:disable-next-line:no-floating-promises
            (async () => {
                const selectiveDelayMs = configs.SELECTIVE_DELAY_MS;
                const selectiveDelayForThisTestMs = 1000;
                configs.SELECTIVE_DELAY_MS = selectiveDelayForThisTestMs;

                // Do fill request async
                const order = await orderFactory.newSignedOrderAsync();
                const takerAssetFillAmount = order.takerAssetAmount.div(2);
                const data = contractWrappers.exchange.fillOrder.getABIEncodedTransactionData(
                    order,
                    takerAssetFillAmount,
                    order.signature,
                );
                const signedFillTransaction = createSignedTransaction(data, takerAddress);
                const fillBody = {
                    signedTransaction: signedFillTransaction,
                    txOrigin: takerAddress,
                };
                // Don't block here, but continue
                // tslint:disable-next-line:no-floating-promises
                request(app)
                    .post(HTTP_REQUEST_TRANSACTION_ENDPOINT_PATH)
                    .send(fillBody)
                    .then((fillResponse: request.Response) => {
                        expect(fillResponse.status).to.be.equal(HttpStatus.BAD_REQUEST);
                        expect(fillResponse.body.code).to.be.equal(GeneralErrorCodes.ValidationError);
                        expect(fillResponse.body.validationErrors[0].code).to.be.equal(
                            ValidationErrorCodes.IncludedOrderAlreadySoftCancelled,
                        );
                        done();
                    });

                // wait 100ms to guarentee that first request gets to awaiting the selective delay
                await utils.sleepAsync(100);

                // Do cancellation request
                const cancelData = contractWrappers.exchange.cancelOrder.getABIEncodedTransactionData(order);
                const signedCancelTransaction = createSignedTransaction(cancelData, makerAddress);
                const cancelBody = {
                    signedTransaction: signedCancelTransaction,
                    txOrigin: makerAddress,
                };
                const response = await request(app)
                    .post(HTTP_REQUEST_TRANSACTION_ENDPOINT_PATH)
                    .send(cancelBody);
                expect(response.status).to.be.equal(HttpStatus.OK);
                expect(response.body.outstandingFillSignatures).to.be.instanceOf(Array);
                expect(response.body.outstandingFillSignatures.length).to.be.equal(0);
                expect(response.body.cancellationSignatures.length).to.be.equal(1);

                configs.SELECTIVE_DELAY_MS = selectiveDelayMs; // Reset the selective delay at end of test
            })();
        });
    });
    describe('#/v1/soft_cancels', () => {
        before(async () => {
            app = await getAppAsync(
                {
                    [NETWORK_ID]: provider,
                },
                configs,
            );
        });
        it('should return 400 Bad Request if request body does not conform to schema', async () => {
            const invalidBody = {};
            const response = await request(app)
                .post(HTTP_SOFT_CANCELS_ENDPOINT_PATH)
                .send(invalidBody);
            expect(response.status).to.be.equal(HttpStatus.BAD_REQUEST);
            expect(response.body.code).to.be.equal(GeneralErrorCodes.ValidationError);
            expect(response.body.validationErrors[0].code).to.be.equal(ValidationErrorCodes.RequiredField);
            expect(response.body.validationErrors[0].field).to.be.equal('orderHashes');
        });
        it('should return 200 OK & empty array if no soft cancelled order hashes could be found', async () => {
            const orderOne = await orderFactory.newSignedOrderAsync();
            const requestBody = {
                orderHashes: [orderModel.getHash(orderOne)],
            };
            const response = await request(app)
                .post(HTTP_SOFT_CANCELS_ENDPOINT_PATH)
                .send(requestBody);
            expect(response.status).to.be.equal(HttpStatus.OK);
            expect(response.body.orderHashes).to.be.instanceOf(Array);
            expect(response.body.orderHashes.length).to.be.equal(0);
        });
        it('should return 200 OK & return a list of order hashes that are soft cancelled', async () => {
            // Generate 4 orders, and soft cancel 3 of them
            const orderOne = await orderFactory.newSignedOrderAsync();
            const orderTwo = await orderFactory.newSignedOrderAsync();
            const orderThree = await orderFactory.newSignedOrderAsync();
            const orderFour = await orderFactory.newSignedOrderAsync();
            const cancelData = contractWrappers.exchange.batchCancelOrders.getABIEncodedTransactionData([
                orderOne,
                orderTwo,
                orderThree,
            ]);
            const signedTransaction = createSignedTransaction(cancelData, makerAddress);
            const body = {
                signedTransaction,
                txOrigin: makerAddress,
            };
            await request(app)
                .post(HTTP_REQUEST_TRANSACTION_ENDPOINT_PATH)
                .send(body);

            const orderHashes = [
                orderModel.getHash(orderOne),
                orderModel.getHash(orderTwo),
                orderModel.getHash(orderThree),
                orderModel.getHash(orderFour),
            ];

            const response = await request(app)
                .post(HTTP_SOFT_CANCELS_ENDPOINT_PATH)
                .send({
                    orderHashes,
                });

            expect(response.status).to.be.equal(HttpStatus.OK);
            expect(response.body.orderHashes).to.be.instanceOf(Array);
            expect(response.body.orderHashes.length).to.be.equal(3);
            expect(response.body.orderHashes).to.contain(orderHashes[0]);
            expect(response.body.orderHashes).to.contain(orderHashes[1]);
            expect(response.body.orderHashes).to.contain(orderHashes[2]);
            expect(response.body.orderHashes).to.not.contain(orderHashes[3]);
        });
    });
    describe(WS_NOTIFICATION_ENDPOINT_PATH, () => {
        before(async () => {
            app = await getAppAsync(
                {
                    [NETWORK_ID]: provider,
                },
                configs,
            );
            app.listen(TEST_PORT, () => {
                utils.log(`Coordinator SERVER API (HTTP) listening on port ${TEST_PORT}`);
            });
        });
        beforeEach(async () => {
            wsClient = new WebSocket.w3cwebsocket(`ws://127.0.0.1:${TEST_PORT}${WS_NOTIFICATION_ENDPOINT_PATH}`);
        });
        afterEach(async () => {
            wsClient.close();
        });
        it('should emit WS event when valid fill request received and again after the selective delay', async () => {
            // Register an onMessage handler to the WS client
            const messageCount = 2;
            const clientOnMessagePromises = onMessage(wsClient, messageCount);

            // Send fill request
            const order = await orderFactory.newSignedOrderAsync();
            const takerAssetFillAmount = order.takerAssetAmount.div(2);
            const data = contractWrappers.exchange.fillOrder.getABIEncodedTransactionData(
                order,
                takerAssetFillAmount,
                order.signature,
            );
            const signedTransaction = createSignedTransaction(data, takerAddress);
            const body = {
                signedTransaction,
                txOrigin: takerAddress,
            };
            const headers = new Headers({
                'content-type': 'application/json',
            });
            await fetchAsync(HTTP_REQUEST_TRANSACTION_URL, {
                headers,
                method: 'POST',
                body: JSON.stringify(body),
            });

            // Check that received event broadcast
            const FillRequestReceivedEventMessage = await clientOnMessagePromises[0];
            const fillRequestReceivedEvent = JSON.parse(FillRequestReceivedEventMessage.data);
            const transactionHash = transactionHashUtils.getTransactionHashHex(signedTransaction);
            const expectedFillRequestReceivedEvent: FillRequestReceivedEvent = {
                type: EventTypes.FillRequestReceived,
                data: {
                    transactionHash,
                },
            };
            expect(fillRequestReceivedEvent).to.be.deep.equal(expectedFillRequestReceivedEvent);

            // Check that accepted event broadcast
            const FillRequestAcceptedEventMessage = await clientOnMessagePromises[1];
            const fillRequestAcceptedEvent = JSON.parse(FillRequestAcceptedEventMessage.data);
            expect(fillRequestAcceptedEvent.type).to.be.equal(EventTypes.FillRequestAccepted);
            expect(fillRequestAcceptedEvent.data.approvalSignatures).to.not.be.undefined();
            expect(fillRequestAcceptedEvent.data.approvalSignatures.length).to.be.equal(1);
            expect(fillRequestAcceptedEvent.data.approvalExpirationTimeSeconds).to.not.be.undefined();
        });
        it('should emit WS event when valid cancel request accepted', async () => {
            // Register an onMessage handler to the WS client
            const messageCount = 1;
            const clientOnMessagePromises = onMessage(wsClient, messageCount);

            // Send fill request
            const order = await orderFactory.newSignedOrderAsync();
            const cancelData = contractWrappers.exchange.cancelOrder.getABIEncodedTransactionData(order);
            const signedTransaction = createSignedTransaction(cancelData, makerAddress);
            const body = {
                signedTransaction,
                txOrigin: makerAddress,
            };
            const headers = new Headers({
                'content-type': 'application/json',
            });
            await fetchAsync(HTTP_REQUEST_TRANSACTION_URL, {
                headers,
                method: 'POST',
                body: JSON.stringify(body),
            });

            // Check that received event broadcast
            const cancelRequestAcceptedEventMessage = await clientOnMessagePromises[0];
            const cancelRequestAcceptedEvent = JSON.parse(cancelRequestAcceptedEventMessage.data);
            const unsignedTransaction = utils.getUnmarshalledObject(utils.getUnsignedTransaction(signedTransaction));
            const unsignedOrder = utils.convertToUnsignedOrder(order);
            const expectedCancelRequestAcceptedEvent: CancelRequestAccepted = {
                type: EventTypes.CancelRequestAccepted,
                data: {
                    orders: [utils.getUnmarshalledObject(unsignedOrder)],
                    transaction: unsignedTransaction as ZeroExTransaction,
                },
            };
            expect(cancelRequestAcceptedEvent).to.be.deep.equal(expectedCancelRequestAcceptedEvent);
        });
    });
});

interface WsMessage {
    data: string;
}

function onMessage(client: WebSocket.w3cwebsocket, messageNumber: number): Array<Promise<WsMessage>> {
    const promises = [];
    const resolves: Array<(msg: any) => void> = [];
    for (let i = 0; i < messageNumber; i++) {
        const p = new Promise<WsMessage>(resolve => {
            resolves.push(resolve);
        });
        promises.push(p);
    }

    let j = 0;
    client.onmessage = (msg: WsMessage) => {
        const resolve = resolves[j];
        resolve(msg);
        j++;
    };

    return promises;
} // tslint:disable:max-file-line-count

function createSignedTransaction(data: string, signerAddress: string): SignedZeroExTransaction {
    const privateKey = TESTRPC_PRIVATE_KEYS[accounts.indexOf(signerAddress)];
    transactionFactory = new TransactionFactory(privateKey, contractAddresses.exchange);
    const signedTransaction = transactionFactory.newSignedTransaction(data, SignatureType.EIP712);
    return signedTransaction;
}
