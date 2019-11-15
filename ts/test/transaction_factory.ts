import { signingUtils } from '@0x/contracts-test-utils';
import { generatePseudoRandomSalt, transactionHashUtils } from '@0x/order-utils';
import { SignatureType, SignedZeroExTransaction } from '@0x/types';
import { BigNumber } from '@0x/utils';
import * as ethUtil from 'ethereumjs-util';

export class TransactionFactory {
    private readonly _signerBuff: Buffer;
    private readonly _exchangeAddress: string;
    private readonly _privateKey: Buffer;
    constructor(privateKey: Buffer, exchangeAddress: string) {
        this._privateKey = privateKey;
        this._exchangeAddress = exchangeAddress;
        this._signerBuff = ethUtil.privateToAddress(this._privateKey);
    }
    public newSignedTransaction(data: string, signatureType: SignatureType): SignedZeroExTransaction {
        const salt = generatePseudoRandomSalt();
        const expirationTimeSeconds = new BigNumber(9999999999); // @todo Update
        const gasPrice = new BigNumber(1);
        const signerAddress = `0x${this._signerBuff.toString('hex')}`;
        const domain = {
            chainId: 1337, // @todo update
            verifyingContract: this._exchangeAddress,
        };
        const transaction = {
            salt,
            expirationTimeSeconds,
            gasPrice,
            signerAddress,
            data,
            domain,
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
