export const configs = {
    // Network port to listen on
    HTTP_PORT: 3000,
    // Default network id to use when not specified
    NETWORK_ID: 50,
    // Ethereum RPC url
    RPC_URL: 'https://mainnet.infura.io/v3/e2c067d9717e492091d1f1d7a2ec55aa',
    // The fee recipient for orders
    FEE_RECIPIENT: '0x78dc5d2d739606d31509c31d654056a45185ecb6',
    // The fee recipient address private key
    FEE_RECIPIENT_PRIVATE_KEY: '752dd9cf65e68cfaba7d60225cbdbc1f4729dd5e5507def72815ed0d8abc6249',
    // Optional selective delay on fill requests
    SELECTIVE_DELAY_MS: 0,
    EXPIRATION_DURATION_SECONDS: 60, // 1 minute
};
