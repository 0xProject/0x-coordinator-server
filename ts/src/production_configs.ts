import * as _ from 'lodash';

export const configs = {
    // Network port to listen on
    HTTP_PORT: process.env.COORDINATOR_HTTP_PORT === undefined ? 3000 : _.parseInt(process.env.COORDINATOR_HTTP_PORT),
    // Ethereum RPC url
    NETWORK_ID_TO_SETTINGS: {
        1: {
            FEE_RECIPIENTS: [
                {
                    ADDRESS: process.env.MAINNET_FEE_RECIPIENT_ADDRESS_ONE || 'FILL_ME_IN',
                    PRIVATE_KEY: process.env.MAINNET_FEE_RECIPIENT_PRIVATE_KEY_ONE || 'FILL_ME_IN',
                },
            ],
            RPC_URL: process.env.MAINNET_RPC_URL || 'https://mainnet.infura.io/v3/e2c067d9717e492091d1f1d7a2ec55aa',
        },
    },
    // Optional selective delay on fill requests
    SELECTIVE_DELAY_MS:
        process.env.SELECTIVE_DELAY_MS === undefined ? 1000 : _.parseInt(process.env.SELECTIVE_DELAY_MS),
    EXPIRATION_DURATION_SECONDS:
        process.env.EXPIRATION_DURATION_SECONDS === undefined
            ? 60
            : _.parseInt(process.env.EXPIRATION_DURATION_SECONDS), // 1 minute
    // Optional reserved fill slots
    RESERVED_FILL_SLOTS: process.env.RESERVED_FILL_SLOTS === undefined ? true : process.env.RESERVED_FILL_SLOTS == "true"
};
