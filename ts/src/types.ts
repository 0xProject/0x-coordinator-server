import { BigNumber, ContractWrappers, ZeroExTransaction } from '0x.js';
import { Web3ProviderEngine } from '@0x/subproviders';
import { Order } from '@0x/types';
import * as WebSocket from 'websocket';

export interface Configs {
    HTTP_PORT: number;
    NETWORK_ID_TO_SETTINGS: NetworkIdToNetworkSpecificSettings;
    SELECTIVE_DELAY_MS: number;
    EXPIRATION_DURATION_SECONDS: number;
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
        orders: Order[];
        zeroExTransaction: ZeroExTransaction;
    };
}

export interface FillRequestAcceptedEvent {
    type: EventTypes;
    data: {
        functionName: string;
        orders: Order[];
        zeroExTransaction: ZeroExTransaction;
        coordinatorSignature: string;
        coordinatorSignatureExpiration: number;
    };
}

export interface CancelRequestAccepted {
    type: EventTypes;
    data: {
        orders: Order[];
        zeroExTransaction: ZeroExTransaction;
    };
}

export interface OrderHashToFillAmount {
    [orderHash: string]: BigNumber;
}

export type BroadcastMessage = FillRequestReceivedEvent | FillRequestAcceptedEvent | CancelRequestAccepted;

export type BroadcastCallback = (message: BroadcastMessage, networkId: number) => void;

export interface OutstandingSignature {
    coordinatorSignature: string;
    expirationTimeSeconds: number;
    orderHash: string;
    takerAssetFillAmount: BigNumber;
}

export interface NetworkSpecificSettings {
    FEE_RECIPIENT_ADDRESS: string;
    FEE_RECIPIENT_PRIVATE_KEY: string;
    RPC_URL: string;
}

export interface NetworkIdToNetworkSpecificSettings {
    [networkId: number]: NetworkSpecificSettings;
}

export interface NetworkIdToProvider {
    [networkId: number]: Web3ProviderEngine;
}

export interface NetworkIdToContractWrappers {
    [networkId: number]: ContractWrappers;
}

export interface NetworkIdToConnectionStore {
    [networkId: number]: Set<WebSocket.connection>;
}
