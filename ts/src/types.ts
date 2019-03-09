import { BigNumber, ZeroExTransaction } from '0x.js';
import { OrderWithoutExchangeAddress } from '@0x/types';

export interface Configs {
    HTTP_PORT: string;
    NETWORK_ID: number;
    RPC_URL: string;
    FEE_RECIPIENT: string;
    FEE_RECIPIENT_PRIVATE_KEY: string;
    SELECTIVE_DELAY_MS: number;
    EXPIRATION_DURATION_SECONDS: number;
}

export enum RequestTransactionErrors {
    InvalidBody = 'INVALID_BODY',
    DecodingTransactionFailed = 'DECODING_TRANSACTION_FAILED',
    CoordinatorFeeRecipientNotFound = 'COORDINATOR_FEE_RECIPIENT_NOT_FOUND',
    CancellationTransactionNotSignedByMaker = 'CANCELLATION_TRANSACTION_NOT_SIGNED_BY_MAKER',
    InvalidTransactionSignature = 'INVALID_TRANSACTION_SIGNATURE',
    InvalidFunctionCall = 'INVALID_FUNCTION_CALL',
    OrderCancelled = 'ORDER_CANCELLED',
    FillRequestAlreadyIssued = 'FILL_REQUEST_ALREADY_ISSUED',
    FillRequestsExceededTakerAssetAmount = 'FILL_REQUESTS_EXCEEDED_TAKER_ASSET_AMOUNT',
    DelegatingTransactionSubmissionDisabled = 'DELEGATING_TRANSACTION_SUBMISSION_DISABLED',
}

export interface RequestTransactionResponse {
    signature: string;
    expirationTimeSeconds: number;
}

export interface CoordinatorApproval {
    txOrigin: string;
    transactionHash: string;
    transactionSignature: string;
    approvalExpirationTimeSeconds: number;
}

export interface Response {
    status: number;
    body?: any;
}

export enum EventTypes {
    FillRequestAccepted = 'FILL_REQUEST_ACCEPTED',
    FillRequestReceived = 'FILL_REQUEST_RECEIVED',
    CancelRequestAccepted = 'CANCEL_REQUEST_ACCEPTED',
}

export interface FillRequestReceivedEvent {
    type: EventTypes;
    data: {
        functionName: string;
        ordersWithoutExchangeAddress: OrderWithoutExchangeAddress[];
        zeroExTransaction: ZeroExTransaction;
    };
}

export interface FillRequestAcceptedEvent {
    type: EventTypes;
    data: {
        functionName: string;
        ordersWithoutExchangeAddress: OrderWithoutExchangeAddress[];
        zeroExTransaction: ZeroExTransaction;
        coordinatorSignature: string;
        coordinatorSignatureExpiration: number;
    };
}

export interface CancelRequestAccepted {
    type: EventTypes;
    data: {
        ordersWithoutExchangeAddress: OrderWithoutExchangeAddress[];
        zeroExTransaction: ZeroExTransaction;
    };
}

export interface OrderHashToFillAmount {
    [orderHash: string]: BigNumber;
}

export type BroadcastMessage = FillRequestReceivedEvent | FillRequestAcceptedEvent | CancelRequestAccepted;

export type BroadcastCallback = (message: BroadcastMessage) => void;

export interface OutstandingSignature {
    signature: string;
    expirationTimeSeconds: number;
    orderHash: string;
    takerAssetFillAmount: BigNumber;
}
