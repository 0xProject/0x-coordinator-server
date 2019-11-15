import { signingUtils } from '@0x/contracts-test-utils';
import { generatePseudoRandomSalt, transactionHashUtils } from '@0x/order-utils';
import { SignatureType, SignedZeroExTransaction } from '@0x/types';
import { BigNumber } from '@0x/utils';
import * as ethUtil from 'ethereumjs-util';

import { utils } from '../src/utils';

import * as constants from './constants';
import { configs } from './test_configs';

export class TransactionFactory {
    private readonly _signerBuff: Buffer;
    private readonly _exchangeAddress: string;
    private readonly _privateKey: Buffer;
    constructor(privateKey: Buffer, exchangeAddress: string) {
        this._privateKey = privateKey;
        this._exchangeAddress = exchangeAddress;
        this._signerBuff = ethUtil.privateToAddress(this._privateKey);
    }
    public newSignedTransaction(
        data: string,
        signatureType: SignatureType,
        transactionData?: Partial<SignedZeroExTransaction>,
    ): SignedZeroExTransaction {
        const salt = generatePseudoRandomSalt();
        const expirationTimeSeconds = new BigNumber(
            utils.getCurrentTimestampSeconds() + configs.EXPIRATION_DURATION_SECONDS,
        );
        const gasPrice = constants.DEFAULT_GAS_PRICE;
        const signerAddress = `0x${this._signerBuff.toString('hex')}`;
        const domain = {
            chainId: constants.TEST_CHAIN_ID,
            verifyingContract: this._exchangeAddress,
        };
        const transaction = {
            salt,
            expirationTimeSeconds,
            gasPrice,
            signerAddress,
            data,
            domain,
            ...transactionData,
        };
        const transactionHashBuffer = transactionHashUtils.getTransactionHashBuffer(transaction);
        const signature = signingUtils.signMessage(transactionHashBuffer, this._privateKey, signatureType);
        const signedTransaction = {
            ...transaction,
            signature: `0x${signature.toString('hex')}`,
        };
        return signedTransaction;
    }
}
