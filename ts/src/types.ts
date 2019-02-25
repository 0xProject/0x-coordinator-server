export enum RequestTransactionErrors {
    DecodingTransactionFailed = 'DECODING_TRANSACTION_FAILED',
    TECFeeRecipientNotFound = 'TEC_FEE_RECIPIENT_NOT_FOUND',
    CancellationTransactionNotSignedByMaker = 'CANCELLATION_TRANSACTION_NOT_SIGNED_BY_MAKER',
    InvalidTransactionSignature = 'INVALID_TRANSACTION_SIGNATURE',
    InvalidFunctionCall = 'INVALID_FUNCTION_CALL',
    OrderCancelled = 'ORDER_CANCELLED',
    FillRequestAlreadyIssued = 'FILL_REQUEST_ALREADY_ISSUED',
}

export interface RequestTransactionResponse {
    signature: string;
    expiration: number;
}

export interface TECApproval {
    transactionHash: string;
    transactionSignature: string;
    approvalExpirationTimeSeconds: number;
}

export interface Response {
    status: number;
    body?: any;
}
