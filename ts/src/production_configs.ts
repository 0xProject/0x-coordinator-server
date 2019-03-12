import { constants } from './constants';

export const configs = {
    // Network port to listen on
    HTTP_PORT: 3000,
    // Ethereum RPC url
    NETWORK_ID_TO_SETTINGS: {
        1: {
            FEE_RECIPIENT_ADDRESS: constants.PLACEHOLDER,
            FEE_RECIPIENT_PRIVATE_KEY: constants.PLACEHOLDER,
            RPC_URL: 'https://mainnet.infura.io/v3/e2c067d9717e492091d1f1d7a2ec55aa',
        },
    },
    // Optional selective delay on fill requests
    SELECTIVE_DELAY_MS: 1000,
    EXPIRATION_DURATION_SECONDS: 60, // 1 minute
};
