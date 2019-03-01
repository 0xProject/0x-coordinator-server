import { assetDataUtils, ContractWrappers, SignatureType, ZeroExTransaction } from '0x.js';
import { ContractAddresses, getContractAddressesForNetworkOrThrow } from '@0x/contract-addresses';
import { constants, OrderFactory } from '@0x/contracts-test-utils';
import { BlockchainLifecycle, web3Factory } from '@0x/dev-utils';
import { BigNumber, fetchAsync } from '@0x/utils';
import { Web3Wrapper } from '@0x/web3-wrapper';
import * as chai from 'chai';
import * as chaiAsPromised from 'chai-as-promised';
import ChaiBigNumber = require('chai-bignumber');
import * as dirtyChai from 'dirty-chai';
import { Provider } from 'ethereum-types';
import * as ethUtil from 'ethereumjs-util';
import * as http from 'http';
import * as HttpStatus from 'http-status-codes';
import * as _ from 'lodash';
import 'mocha';
import * as request from 'supertest';
import * as WebSocket from 'websocket';

import { getAppAsync } from '../src/app';
import { FEE_RECIPIENT, NETWORK_ID } from '../src/config';
import { FillRequestEntity } from '../src/entities/fill_request_entity';
import { fillRequest } from '../src/models/fill_request';
import { signedOrder } from '../src/models/signed_order';
import { CancelRequestAccepted, EventTypes, FillRequestReceivedEvent, RequestTransactionErrors } from '../src/types';
import { utils } from '../src/utils';

import { TESTRPC_PRIVATE_KEYS_STRINGS } from './constants';
import { TransactionFactory } from './transaction_factory';

chai.config.includeStack = true;
chai.use(ChaiBigNumber());
chai.use(dirtyChai);
chai.use(chaiAsPromised);
const expect = chai.expect;

const TESTRPC_PRIVATE_KEYS = _.map(TESTRPC_PRIVATE_KEYS_STRINGS, privateKeyString =>
    ethUtil.toBuffer(privateKeyString),
);

let app: http.Server;

let owner: string;
let senderAddress: string;
let makerAddress: string;
let takerAddress: string;
let tecSignerAddress: string;
let transactionFactory: TransactionFactory;
let orderFactory: OrderFactory;
let provider: Provider;
let accounts: string[];
let contractAddresses: ContractAddresses;
let blockchainLifecycle: BlockchainLifecycle;
let contractWrappers: ContractWrappers;

// Websocket tests only
const TEST_PORT = 8361;
const REQUESTS_PATH = '/v1/requests';
let wsClient: WebSocket.w3cwebsocket;

const DEFAULT_MAKER_TOKEN_ADDRESS = '0x1e2f9e10d02a6b8f8f69fcbf515e75039d2ea30d';
const DEFAULT_TAKER_TOKEN_ADDRESS = '0xbe0037eaf2d64fe5529bca93c18c9702d3930376';
const NOT_TEC_FEE_RECIPIENT_ADDRESS = '0xb27ec3571c6abaa95db65ee7fec60fb694cbf822';

describe('TEC server', () => {
    before(async () => {
        provider = web3Factory.getRpcProvider({
            shouldUseInProcessGanache: true,
            ganacheDatabasePath: './0x_ganache_snapshot',
        });

        const web3Wrapper = new Web3Wrapper(provider);
        // TODO(fabio): Fix Web3Wrapper incompatability issues
        blockchainLifecycle = new BlockchainLifecycle(web3Wrapper as any);

        await blockchainLifecycle.startAsync();
        accounts = await web3Wrapper.getAvailableAddressesAsync();
        [owner, senderAddress, makerAddress, takerAddress, tecSignerAddress] = _.slice(accounts, 0, 6);
        owner = owner; // TODO(fabio): Remove later, once we use owner
        tecSignerAddress = tecSignerAddress; // TODO(fabio): Remove later, once we use tecSignerAddress

        contractAddresses = getContractAddressesForNetworkOrThrow(NETWORK_ID);
        const defaultOrderParams = {
            ...constants.STATIC_ORDER_PARAMS,
            senderAddress,
            exchangeAddress: contractAddresses.exchange,
            makerAddress,
            feeRecipientAddress: FEE_RECIPIENT,
            makerAssetData: assetDataUtils.encodeERC20AssetData(DEFAULT_MAKER_TOKEN_ADDRESS),
            takerAssetData: assetDataUtils.encodeERC20AssetData(DEFAULT_TAKER_TOKEN_ADDRESS),
        };
        const makerPrivateKey = TESTRPC_PRIVATE_KEYS[accounts.indexOf(makerAddress)];
        orderFactory = new OrderFactory(makerPrivateKey, defaultOrderParams);

        contractWrappers = new ContractWrappers(provider, {
            networkId: NETWORK_ID,
        });
    });
    after(async () => {
        await blockchainLifecycle.revertAsync();
    });
    beforeEach(async () => {
        await blockchainLifecycle.startAsync();
    });
    afterEach(async () => {
        await blockchainLifecycle.revertAsync();
    });
    describe('#/v1/request_transaction', () => {
        before(async () => {
            app = await getAppAsync(provider);
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
                    verifyingContractAddress: '0x48bacb9266a570d521063ef5dd96e61686dbe788',
                    signature:
                        '0x1cc0b3a07c8bd0346e8ad34278beb28f5b90720ccfde3fe761333971e2b130abd75546534e8d8f0b476c201c573ffeb0c24ed2753ba70e4fe68820075b5eaf1a0003',
                },
            };
            const response = await request(app)
                .post('/v1/request_transaction')
                .send(invalidBody);
            expect(response.status).to.be.equal(HttpStatus.BAD_REQUEST);
        });
        it('should return 400 Bad Request if signature is invalid', async () => {
            const invalidBody = {
                signedTransaction: {
                    salt: new BigNumber(
                        '57466949743788259527933166264332732046478076361192368690875627090773188231774',
                    ),
                    signerAddress: '0xe834ec434daba538cd1b9fe1582052b880bd7e63',
                    data:
                        '0xb4be83d500000000000000000000000000000000000000000000000000000000000000600000000000000000000000000000000000000000000000056bc75e2d6310000000000000000000000000000000000000000000000000000000000000000002a0000000000000000000000000e36ea790bc9d7ab70c55260c66d52b1eca985f84000000000000000000000000000000000000000000000000000000000000000000000000000000000000000078dc5d2d739606d31509c31d654056a45185ecb60000000000000000000000006ecbe1db9ef729cbe972c83fb886247691fb6beb0000000000000000000000000000000000000000000000056bc75e2d6310000000000000000000000000000000000000000000000000000ad78ebc5ac62000000000000000000000000000000000000000000000000000000de0b6b3a76400000000000000000000000000000000000000000000000000000de0b6b3a7640000000000000000000000000000000000000000000000000000000000005c6dfa8c3aeb4634b714b7f4f0b235cf8b77707f0c8d36d1ea8b28b44560c5caa323d855000000000000000000000000000000000000000000000000000000000000018000000000000000000000000000000000000000000000000000000000000001e00000000000000000000000000000000000000000000000000000000000000024f47261b00000000000000000000000001e2f9e10d02a6b8f8f69fcbf515e75039d2ea30d000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000024f47261b0000000000000000000000000be0037eaf2d64fe5529bca93c18c9702d39303760000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000421b2f1cd06f64e08a71d6cb579a086c356f313ebc2aeeb66a827408aab78439ec7724dfd59fbad7a4c8009f893f724cab90d0f82f45c49f9f76c7e1d7a2c7f2ca4203000000000000000000000000000000000000000000000000000000000000',
                    verifyingContractAddress: '0x48bacb9266a570d521063ef5dd96e61686dbe788',
                    // Invalid signature
                    signature:
                        '0x1b73ae1c93d58da1162dcf896111afce37439f1f24adcbeb7a9c7407920a3bd3010fad757de911d8b5e1067dd210aca35a027dd154a0167c4a15278af22904b70b03',
                },
            };
            const response = await request(app)
                .post('/v1/request_transaction')
                .send(invalidBody);
            expect(response.status).to.be.equal(HttpStatus.BAD_REQUEST);
            expect(response.text).to.be.equal(RequestTransactionErrors.InvalidTransactionSignature);
        });
        it('should return 400 INVALID_FEE_RECIPIENT if transaction sent with order without TECs feeRecipientAddress', async () => {
            const order = await orderFactory.newSignedOrderAsync({
                feeRecipientAddress: NOT_TEC_FEE_RECIPIENT_ADDRESS,
            });
            const takerAssetFillAmount = order.takerAssetAmount.div(2);
            const transactionEncoder = await contractWrappers.exchange.transactionEncoderAsync();
            const data = transactionEncoder.fillOrderTx(order, takerAssetFillAmount);
            const takerPrivateKey = TESTRPC_PRIVATE_KEYS[accounts.indexOf(takerAddress)];
            transactionFactory = new TransactionFactory(takerPrivateKey, contractAddresses.exchange);
            const signedTransaction = transactionFactory.newSignedTransaction(data, SignatureType.EthSign);
            const body = {
                signedTransaction,
            };
            const response = await request(app)
                .post('/v1/request_transaction')
                .send(body);
            expect(response.status).to.be.equal(HttpStatus.BAD_REQUEST);
            expect(response.text).to.be.equal(RequestTransactionErrors.TECFeeRecipientNotFound);
        });
        it('should return 400 if transaction cannot be decoded', async () => {
            const invalidData =
                '0xa4be84d500000000000000000000000000000000000000000000000000000000000000600000000000000000000000000000000000000000000000056bc75e2d6310000000000000000000000000000000000000000000000000000000000000000002a0000000000000000000000000e36ea790bc9d7ab70c55260c66d52b1eca985f84000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000006ecbe1db9ef729cbe972c83fb886247691fb6beb0000000000000000000000000000000000000000000000056bc75e2d6310000000000000000000000000000000000000000000000000000ad78ebc5ac62000000000000000000000000000000000000000000000000000000de0b6b3a76400000000000000000000000000000000000000000000000000000de0b6b3a7640000000000000000000000000000000000000000000000000000000000005c60629ac12f9da01839cabc64cb7d0ddeee4bdda46e6b9b00f66cb469d57bcd871fb6fb000000000000000000000000000000000000000000000000000000000000018000000000000000000000000000000000000000000000000000000000000001e00000000000000000000000000000000000000000000000000000000000000024f47261b00000000000000000000000001e2f9e10d02a6b8f8f69fcbf515e75039d2ea30d000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000024f47261b0000000000000000000000000be0037eaf2d64fe5529bca93c18c9702d39303760000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000421c45cd8e03845be9c5878cd2fec5ae2b75ff36de4ff331680d4e6cca57c8b9d38f2ad9af72e5f56f3c2da6eff57373dca43122642c5fa29d0a83b4f63f413c083a03000000000000000000000000000000000000000000000000000000000000';
            const takerPrivateKey = TESTRPC_PRIVATE_KEYS[accounts.indexOf(takerAddress)];
            transactionFactory = new TransactionFactory(takerPrivateKey, contractAddresses.exchange);
            const signedTransaction = transactionFactory.newSignedTransaction(invalidData, SignatureType.EthSign);
            const body = {
                signedTransaction,
            };
            const response = await request(app)
                .post('/v1/request_transaction')
                .send(body);
            expect(response.status).to.be.equal(HttpStatus.BAD_REQUEST);
            expect(response.text).to.be.equal(RequestTransactionErrors.DecodingTransactionFailed);
        });
        it('should return 400 if batch cancellation transaction not signed by order maker', async () => {
            const order = await orderFactory.newSignedOrderAsync();
            const transactionEncoder = await contractWrappers.exchange.transactionEncoderAsync();
            const data = transactionEncoder.batchCancelOrdersTx([order]);
            const notMakerPrivateKey = TESTRPC_PRIVATE_KEYS[accounts.indexOf(takerAddress)];
            transactionFactory = new TransactionFactory(notMakerPrivateKey, contractAddresses.exchange);
            const signedTransaction = transactionFactory.newSignedTransaction(data, SignatureType.EthSign);
            const body = {
                signedTransaction,
            };
            const response = await request(app)
                .post('/v1/request_transaction')
                .send(body);
            expect(response.status).to.be.equal(HttpStatus.BAD_REQUEST);
            expect(response.text).to.be.equal(RequestTransactionErrors.CancellationTransactionNotSignedByMaker);
        });
        it('should return 200 and only cancel TEC order if only one order sent in batch cancellation is a TEC order', async () => {
            const tecOrder = await orderFactory.newSignedOrderAsync();
            const notTECOrder = await orderFactory.newSignedOrderAsync({
                feeRecipientAddress: NOT_TEC_FEE_RECIPIENT_ADDRESS,
            });
            const transactionEncoder = await contractWrappers.exchange.transactionEncoderAsync();
            const data = transactionEncoder.batchCancelOrdersTx([tecOrder, notTECOrder]);
            const makerPrivateKey = TESTRPC_PRIVATE_KEYS[accounts.indexOf(makerAddress)];
            transactionFactory = new TransactionFactory(makerPrivateKey, contractAddresses.exchange);
            const signedTransaction = transactionFactory.newSignedTransaction(data, SignatureType.EthSign);
            const body = {
                signedTransaction,
            };
            const response = await request(app)
                .post('/v1/request_transaction')
                .send(body);
            expect(response.status).to.be.equal(HttpStatus.OK);

            // Check that only the TEC order got cancelled in DB
            let isCancelled = await signedOrder.isCancelledAsync(tecOrder);
            expect(isCancelled).to.be.true();
            isCancelled = await signedOrder.isCancelledAsync(notTECOrder);
            expect(isCancelled).to.be.false();
        });
        it('should return 200 OK & mark order as cancelled if successfully batch cancelling orders', async () => {
            const orderOne = await orderFactory.newSignedOrderAsync();
            const orderTwo = await orderFactory.newSignedOrderAsync();
            const transactionEncoder = await contractWrappers.exchange.transactionEncoderAsync();
            const cancelTxData = transactionEncoder.batchCancelOrdersTx([orderOne, orderTwo]);
            const makerPrivateKey = TESTRPC_PRIVATE_KEYS[accounts.indexOf(makerAddress)];
            transactionFactory = new TransactionFactory(makerPrivateKey, contractAddresses.exchange);
            const signedTransaction = transactionFactory.newSignedTransaction(cancelTxData, SignatureType.EthSign);
            const body = {
                signedTransaction,
            };
            const response = await request(app)
                .post('/v1/request_transaction')
                .send(body);
            expect(response.status).to.be.equal(HttpStatus.OK);

            // Check that orders cancelled in DB
            let isCancelled = await signedOrder.isCancelledAsync(orderOne);
            expect(isCancelled).to.be.true();
            isCancelled = await signedOrder.isCancelledAsync(orderTwo);
            expect(isCancelled).to.be.true();
        });
        it('should return 400 if cancellation transaction not signed by order maker', async () => {
            const order = await orderFactory.newSignedOrderAsync();
            const transactionEncoder = await contractWrappers.exchange.transactionEncoderAsync();
            const data = transactionEncoder.cancelOrderTx(order);
            const notMakerPrivateKey = TESTRPC_PRIVATE_KEYS[accounts.indexOf(takerAddress)];
            transactionFactory = new TransactionFactory(notMakerPrivateKey, contractAddresses.exchange);
            const signedTransaction = transactionFactory.newSignedTransaction(data, SignatureType.EthSign);
            const body = {
                signedTransaction,
            };
            const response = await request(app)
                .post('/v1/request_transaction')
                .send(body);
            expect(response.status).to.be.equal(HttpStatus.BAD_REQUEST);
            expect(response.text).to.be.equal(RequestTransactionErrors.CancellationTransactionNotSignedByMaker);
        });
        it('should return 400 and leave order uncancelled if non-maker tried to cancel an order', async () => {
            const order = await orderFactory.newSignedOrderAsync();
            const transactionEncoder = await contractWrappers.exchange.transactionEncoderAsync();
            const data = transactionEncoder.cancelOrderTx(order);
            const notMakerPrivateKey = TESTRPC_PRIVATE_KEYS[accounts.indexOf(owner)];
            transactionFactory = new TransactionFactory(notMakerPrivateKey, contractAddresses.exchange);
            const signedTransaction = transactionFactory.newSignedTransaction(data, SignatureType.EthSign);
            const body = {
                signedTransaction,
            };
            const response = await request(app)
                .post('/v1/request_transaction')
                .send(body);
            expect(response.status).to.be.equal(HttpStatus.BAD_REQUEST);
            expect(response.text).to.be.equal(RequestTransactionErrors.CancellationTransactionNotSignedByMaker);

            // Verify that order wasn't cancelled
            const isCancelled = await signedOrder.isCancelledAsync(order);
            expect(isCancelled).to.be.false();
        });
        it('should return 200 OK & mark order as cancelled if successfully cancelling an order', async () => {
            const order = await orderFactory.newSignedOrderAsync();
            const transactionEncoder = await contractWrappers.exchange.transactionEncoderAsync();
            const cancelTxData = transactionEncoder.cancelOrderTx(order);
            const makerPrivateKey = TESTRPC_PRIVATE_KEYS[accounts.indexOf(makerAddress)];
            transactionFactory = new TransactionFactory(makerPrivateKey, contractAddresses.exchange);
            const signedTransaction = transactionFactory.newSignedTransaction(cancelTxData, SignatureType.EthSign);
            const body = {
                signedTransaction,
            };
            const response = await request(app)
                .post('/v1/request_transaction')
                .send(body);
            expect(response.status).to.be.equal(HttpStatus.OK);

            // Check that order cancelled in DB
            const isCancelled = await signedOrder.isCancelledAsync(order);
            expect(isCancelled).to.be.true();

            // Check that someone trying to fill the order, can't
            const takerAssetFillAmount = order.takerAssetAmount.div(2);
            const fillTxData = transactionEncoder.fillOrderTx(order, takerAssetFillAmount);
            const takerPrivateKey = TESTRPC_PRIVATE_KEYS[accounts.indexOf(takerAddress)];
            transactionFactory = new TransactionFactory(takerPrivateKey, contractAddresses.exchange);
            const signedFillTransaction = transactionFactory.newSignedTransaction(fillTxData, SignatureType.EthSign);
            const fillBody = {
                signedTransaction: signedFillTransaction,
            };
            const fillResponse = await request(app)
                .post('/v1/request_transaction')
                .send(fillBody);
            expect(fillResponse.status).to.be.equal(HttpStatus.BAD_REQUEST);
            expect(fillResponse.text).to.be.equal(RequestTransactionErrors.OrderCancelled);
        });
        it('should return 200 OK if request to fill uncancelled order', async () => {
            const order = await orderFactory.newSignedOrderAsync();
            const takerAssetFillAmount = order.takerAssetAmount.div(2);
            const transactionEncoder = await contractWrappers.exchange.transactionEncoderAsync();
            const data = transactionEncoder.fillOrderTx(order, takerAssetFillAmount);
            const takerPrivateKey = TESTRPC_PRIVATE_KEYS[accounts.indexOf(takerAddress)];
            transactionFactory = new TransactionFactory(takerPrivateKey, contractAddresses.exchange);
            const signedTransaction = transactionFactory.newSignedTransaction(data, SignatureType.EthSign);
            const body = {
                signedTransaction,
            };
            const response = await request(app)
                .post('/v1/request_transaction')
                .send(body);
            expect(response.status).to.be.equal(HttpStatus.OK);
            expect(response.body.signature).to.not.be.undefined();
            const currTimestamp = utils.getCurrentTimestampSeconds();
            expect(response.body.expiration).to.be.greaterThan(currTimestamp);

            // Check that fill request was added to DB
            const fillRequestEntityIfExists = await fillRequest.findAsync(takerAddress, response.body.signature);
            expect(fillRequestEntityIfExists).to.not.be.undefined();
            expect((fillRequestEntityIfExists as FillRequestEntity).expirationTimeSeconds).to.be.equal(
                response.body.expiration,
            );

            // Check that takerAssetFillAmount was added to DB
            const signedOrderIfExists = await signedOrder.findAsync(order);
            if (signedOrderIfExists === undefined) {
                throw new Error(`Order was not stored in DB: ${JSON.stringify(order)}`);
            }
            expect(signedOrderIfExists.takerAssetFillAmounts.length).to.equal(1);
            expect(signedOrderIfExists.takerAssetFillAmounts[0].takerAddress).to.equal(takerAddress);
            expect(signedOrderIfExists.takerAssetFillAmounts[0].takerAssetFillAmount).to.be.bignumber.equal(
                takerAssetFillAmount,
            );

            // TODO(fabio): Check that the signature returned would be accepted by the TEC smart contract
        });
        it('should return 400 FILL_REQUESTS_EXCEEDED_TAKER_ASSET_AMOUNT if request to fill an order multiple times fully', async () => {
            const order = await orderFactory.newSignedOrderAsync();
            const takerAssetFillAmount = order.takerAssetAmount; // Full amount
            const transactionEncoder = await contractWrappers.exchange.transactionEncoderAsync();
            const data = transactionEncoder.fillOrderTx(order, takerAssetFillAmount);
            const takerPrivateKey = TESTRPC_PRIVATE_KEYS[accounts.indexOf(takerAddress)];
            transactionFactory = new TransactionFactory(takerPrivateKey, contractAddresses.exchange);
            const signedTransaction = transactionFactory.newSignedTransaction(data, SignatureType.EthSign);
            const body = {
                signedTransaction,
            };
            let response = await request(app)
                .post('/v1/request_transaction')
                .send(body);
            expect(response.status).to.be.equal(HttpStatus.OK);
            expect(response.body.signature).to.not.be.undefined();
            const currTimestamp = utils.getCurrentTimestampSeconds();
            expect(response.body.expiration).to.be.greaterThan(currTimestamp);

            response = await request(app)
                .post('/v1/request_transaction')
                .send(body);
            expect(response.status).to.be.equal(HttpStatus.BAD_REQUEST);
            expect(response.text).to.be.equal(RequestTransactionErrors.FillRequestsExceededTakerAssetAmount);
        });
        it('should return 200 OK if request to match two uncancelled orders', async () => {
            const leftOrder = await orderFactory.newSignedOrderAsync();
            const rightOrder = await orderFactory.newSignedOrderAsync({
                makerAddress: takerAddress,
                takerAddress: makerAddress,
                makerAssetData: assetDataUtils.encodeERC20AssetData(DEFAULT_TAKER_TOKEN_ADDRESS),
                takerAssetData: assetDataUtils.encodeERC20AssetData(DEFAULT_MAKER_TOKEN_ADDRESS),
            });
            const transactionEncoder = await contractWrappers.exchange.transactionEncoderAsync();
            const data = transactionEncoder.matchOrdersTx(leftOrder, rightOrder);
            const takerPrivateKey = TESTRPC_PRIVATE_KEYS[accounts.indexOf(takerAddress)];
            transactionFactory = new TransactionFactory(takerPrivateKey, contractAddresses.exchange);
            const signedTransaction = transactionFactory.newSignedTransaction(data, SignatureType.EthSign);
            const body = {
                signedTransaction,
            };
            const response = await request(app)
                .post('/v1/request_transaction')
                .send(body);
            expect(response.status).to.be.equal(HttpStatus.OK);
            expect(response.body.signature).to.not.be.undefined();
            const currTimestamp = utils.getCurrentTimestampSeconds();
            expect(response.body.expiration).to.be.greaterThan(currTimestamp);

            // Check that fill request was added to DB
            const fillRequestEntityIfExists = await fillRequest.findAsync(takerAddress, response.body.signature);
            expect(fillRequestEntityIfExists).to.not.be.undefined();
            expect((fillRequestEntityIfExists as FillRequestEntity).expirationTimeSeconds).to.be.equal(
                response.body.expiration,
            );

            // TODO(fabio): Add takerAssetFilled checks here

            // TODO(fabio): Check that the signature returned would be accepted by the TEC smart contract
        });
    });
    describe(REQUESTS_PATH, () => {
        before(async () => {
            app = await getAppAsync(provider);
            app.listen(TEST_PORT, () => {
                utils.log(`TEC SERVER API (HTTP) listening on port ${TEST_PORT}`);
            });
        });
        beforeEach(async () => {
            wsClient = new WebSocket.w3cwebsocket(`ws://127.0.0.1:${TEST_PORT}${REQUESTS_PATH}`);
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
            const transactionEncoder = await contractWrappers.exchange.transactionEncoderAsync();
            const data = transactionEncoder.fillOrderTx(order, takerAssetFillAmount);
            const takerPrivateKey = TESTRPC_PRIVATE_KEYS[accounts.indexOf(takerAddress)];
            transactionFactory = new TransactionFactory(takerPrivateKey, contractAddresses.exchange);
            const signedTransaction = transactionFactory.newSignedTransaction(data, SignatureType.EthSign);
            const body = {
                signedTransaction,
            };
            const headers = new Headers({
                'content-type': 'application/json',
            });
            await fetchAsync(`http://127.0.0.1:${TEST_PORT}/v1/request_transaction`, {
                headers,
                method: 'POST',
                body: JSON.stringify(body),
            });

            // Check that received event broadcast
            const FillRequestReceivedEventMessage = await clientOnMessagePromises[0];
            const fillRequestReceivedEvent = JSON.parse(FillRequestReceivedEventMessage.data);
            const unsignedTransaction = utils.getUnmarshalledObject(utils.getUnsignedTransaction(signedTransaction));
            const orderWithoutExchangeAddress = utils.getOrderWithoutExchangeAddress(order);
            const expectedFillRequestReceivedEvent: FillRequestReceivedEvent = {
                type: EventTypes.FillRequestReceived,
                data: {
                    functionName: 'fillOrder',
                    ordersWithoutExchangeAddress: [utils.getUnmarshalledObject(orderWithoutExchangeAddress)],
                    zeroExTransaction: unsignedTransaction as ZeroExTransaction,
                },
            };
            expect(fillRequestReceivedEvent).to.be.deep.equal(expectedFillRequestReceivedEvent);

            // Check that accepted event broadcast
            const FillRequestAcceptedEventMessage = await clientOnMessagePromises[1];
            const fillRequestAcceptedEvent = JSON.parse(FillRequestAcceptedEventMessage.data);
            expect(fillRequestAcceptedEvent.type).to.be.equal(EventTypes.FillRequestAccepted);
            expect(fillRequestAcceptedEvent.data.tecSignature).to.not.be.undefined();
            expect(fillRequestAcceptedEvent.data.tecSignatureExpiration).to.not.be.undefined();
        });
        it('should emit WS event when valid cancel request accepted', async () => {
            // Register an onMessage handler to the WS client
            const messageCount = 1;
            const clientOnMessagePromises = onMessage(wsClient, messageCount);

            // Send fill request
            const order = await orderFactory.newSignedOrderAsync();
            const transactionEncoder = await contractWrappers.exchange.transactionEncoderAsync();
            const cancelTxData = transactionEncoder.cancelOrderTx(order);
            const makerPrivateKey = TESTRPC_PRIVATE_KEYS[accounts.indexOf(makerAddress)];
            transactionFactory = new TransactionFactory(makerPrivateKey, contractAddresses.exchange);
            const signedTransaction = transactionFactory.newSignedTransaction(cancelTxData, SignatureType.EthSign);
            const body = {
                signedTransaction,
            };
            const headers = new Headers({
                'content-type': 'application/json',
            });
            await fetchAsync(`http://127.0.0.1:${TEST_PORT}/v1/request_transaction`, {
                headers,
                method: 'POST',
                body: JSON.stringify(body),
            });

            // Check that received event broadcast
            const cancelRequestAcceptedEventMessage = await clientOnMessagePromises[0];
            const cancelRequestAcceptedEvent = JSON.parse(cancelRequestAcceptedEventMessage.data);
            const unsignedTransaction = utils.getUnmarshalledObject(utils.getUnsignedTransaction(signedTransaction));
            const orderWithoutExchangeAddress = utils.getOrderWithoutExchangeAddress(order);
            const expectedCancelRequestAcceptedEvent: CancelRequestAccepted = {
                type: EventTypes.CancelRequestAccepted,
                data: {
                    ordersWithoutExchangeAddress: [utils.getUnmarshalledObject(orderWithoutExchangeAddress)],
                    zeroExTransaction: unsignedTransaction as ZeroExTransaction,
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
