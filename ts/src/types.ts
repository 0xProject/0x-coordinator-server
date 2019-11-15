import { ContractAddresses, ContractWrappers } from '@0x/contract-wrappers';
import { Web3ProviderEngine } from '@0x/subproviders';
import { Order, ZeroExTransaction } from '@0x/types';
import { BigNumber } from '@0x/utils';
import * as WebSocket from 'websocket';

export interface Configs {
    HTTP_PORT: number;
    CHAIN_ID_TO_SETTINGS: ChainIdToNetworkSpecificSettings;
    CHAIN_ID_TO_CONTRACT_ADDRESSES?: ChainIdToContractAddresses;
    SELECTIVE_DELAY_MS: number;
    EXPIRATION_DURATION_SECONDS: number;
}

export interface RequestTransactionResponse {
    signatures: string[];
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
        transactionHash: string;
    };
}

export interface FillRequestAcceptedEvent {
    type: EventTypes;
    data: {
        functionName: string;
        orders: Order[];
        txOrigin: string;
        signedTransaction: ZeroExTransaction;
        approvalSignatures: string[];
        approvalExpirationTimeSeconds: number;
    };
}

export interface CancelRequestAccepted {
    type: EventTypes;
    data: {
        orders: Order[];
        transaction: ZeroExTransaction;
    };
}

export interface OrderHashToFillAmount {
    [orderHash: string]: BigNumber;
}

export type BroadcastMessage = FillRequestReceivedEvent | FillRequestAcceptedEvent | CancelRequestAccepted;

export type BroadcastCallback = (message: BroadcastMessage, chainId: number) => void;

export interface OutstandingFillSignatures {
    approvalSignatures: string[];
    expirationTimeSeconds: number;
    orderHash: string;
    takerAssetFillAmount: BigNumber;
}

export interface FeeRecipient {
    ADDRESS: string;
    PRIVATE_KEY: string;
}

export interface NetworkSpecificSettings {
    FEE_RECIPIENTS: FeeRecipient[];
    RPC_URL: string;
}

export interface ChainIdToContractAddresses {
    [chainId: number]: ContractAddresses;
}
export interface ChainIdToNetworkSpecificSettings {
    [chainId: number]: NetworkSpecificSettings;
}

export interface ChainIdToProvider {
    [chainId: number]: Web3ProviderEngine;
}

export interface ChainIdToContractWrappers {
    [chainId: number]: ContractWrappers;
}

export interface ChainIdToConnectionStore {
    [chainId: number]: Set<WebSocket.connection>;
}
