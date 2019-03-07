import { BigNumber, ZeroExTransaction } from '0x.js';
import { OrderWithoutExchangeAddress } from '@0x/types';

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
    expiration: number;
}

export interface CoordinatorApproval {
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
