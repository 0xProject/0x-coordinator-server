import { FEE_RECIPIENT_ADDRESS_ONE, FEE_RECIPIENT_ADDRESS_TWO } from './constants';

export const configs = {
    // Network port to listen on
    HTTP_PORT: 3000,
    // The fee recipient details used by the coordinator's relayer for a particular network
    NETWORK_ID_TO_SETTINGS: {
        50: {
            FEE_RECIPIENTS: [
                {
                    ADDRESS: FEE_RECIPIENT_ADDRESS_ONE,
                    PRIVATE_KEY: 'ff12e391b79415e941a94de3bf3a9aee577aed0731e297d5cfa0b8a1e02fa1d0',
                },
                {
                    ADDRESS: FEE_RECIPIENT_ADDRESS_TWO,
                    PRIVATE_KEY: '752dd9cf65e68cfaba7d60225cbdbc1f4729dd5e5507def72815ed0d8abc6249',
                },
            ],
            // Ethereum RPC url
            RPC_URL: 'https://mainnet.infura.io/v3/e2c067d9717e492091d1f1d7a2ec55aa',
        },
    },
    // Optional selective delay on fill requests
    SELECTIVE_DELAY_MS: 0,
    EXPIRATION_DURATION_SECONDS: 60, // 1 minute
};
