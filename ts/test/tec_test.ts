import { assetDataUtils, ContractWrappers, SignatureType } from '0x.js';
import { ContractAddresses, getContractAddressesForNetworkOrThrow } from '@0x/contract-addresses';
import { constants, OrderFactory } from '@0x/contracts-test-utils';
import { BlockchainLifecycle, web3Factory } from '@0x/dev-utils';
import { Web3Wrapper } from '@0x/web3-wrapper';
import * as chai from 'chai';
import * as chaiAsPromised from 'chai-as-promised';
import * as dirtyChai from 'dirty-chai';
import { Provider } from 'ethereum-types';
import * as ethUtil from 'ethereumjs-util';
import * as express from 'express';
import * as HttpStatus from 'http-status-codes';
import * as _ from 'lodash';
import 'mocha';
import * as request from 'supertest';

import { getAppAsync } from '../src/app';
import { FEE_RECIPIENT } from '../src/config';
import { FillRequestEntity } from '../src/entities/fill_request_entity';
import { fillRequest } from '../src/models/fill_request';
import { signedOrder } from '../src/models/signed_order';
import { RequestTransactionErrors } from '../src/types';
import { utils } from '../src/utils';

import { TESTRPC_PRIVATE_KEYS_STRINGS } from './constants';
import { TransactionFactory } from './transaction_factory';

chai.config.includeStack = true;
chai.use(dirtyChai);
chai.use(chaiAsPromised);
const expect = chai.expect;

const NETWORK_ID = 50;
const TESTRPC_PRIVATE_KEYS = _.map(TESTRPC_PRIVATE_KEYS_STRINGS, privateKeyString =>
    ethUtil.toBuffer(privateKeyString),
);

let app: express.Express;

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

const DEFAULT_MAKER_TOKEN_ADDRESS = '0x1e2f9e10d02a6b8f8f69fcbf515e75039d2ea30d';
const DEFAULT_TAKER_TOKEN_ADDRESS = '0xbe0037eaf2d64fe5529bca93c18c9702d3930376';
const NOT_TEC_FEE_RECIPIENT_ADDRESS = '0xb27ec3571c6abaa95db65ee7fec60fb694cbf822';

describe('Server', () => {
    before(async () => {
        provider = web3Factory.getRpcProvider({
            shouldUseInProcessGanache: true,
            ganacheDatabasePath: './0x_ganache_snapshot',
        });

        const web3Wrapper = new Web3Wrapper(provider);
        // TODO(fabio): Fix Web3Wrapper incompatability issues
        blockchainLifecycle = new BlockchainLifecycle(web3Wrapper as any);

        app = await getAppAsync(provider);
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
        it('should return 400 Bad Request if request body does not conform to schema', async () => {
            const invalidBody = {
                signedTransaction: {
                    // Missing signerAddress
                    salt: '10798369788836331947878244228295394663118854512666292664573150674534689981547',
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
                    salt: '57466949743788259527933166264332732046478076361192368690875627090773188231774',
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

            // TODO(fabio): Check that the signature returned would be accepted by the TEC smart contract
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

            // TODO(fabio): Check that the signature returned would be accepted by the TEC smart contract
        });
    });
});