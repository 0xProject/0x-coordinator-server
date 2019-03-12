import { constants } from './constants';

export const configs = {
    // Network port to listen on
    HTTP_PORT: 3000,
    // Default network id to use when not specified
    NETWORK_ID: 1,
    // Ethereum RPC url
    RPC_URL: 'https://mainnet.infura.io/v3/e2c067d9717e492091d1f1d7a2ec55aa',
    // The fee recipient for orders
    FEE_RECIPIENT: constants.PLACEHOLDER,
    // The fee recipient address private key
    FEE_RECIPIENT_PRIVATE_KEY: constants.PLACEHOLDER,
    // Optional selective delay on fill requests
    SELECTIVE_DELAY_MS: 1000,
    EXPIRATION_DURATION_SECONDS: 60, // 1 minute
};
