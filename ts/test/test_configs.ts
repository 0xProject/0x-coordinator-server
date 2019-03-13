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
                    PRIVATE_KEY: '752dd9cf65e68cfaba7d60225cbdbc1f4729dd5e5507def72815ed0d8abc6249',
                },
                {
                    ADDRESS: FEE_RECIPIENT_ADDRESS_TWO,
                    PRIVATE_KEY: 'efb595a0178eb79a8df953f87c5148402a224cdf725e88c0146727c6aceadccd',
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
