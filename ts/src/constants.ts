export const constants = {
    // TODO(fabio): Remove this hard-coding on the coordinator address once re-published contract-addresses
    // package
    // HACK(fabio): Hard-code fake Coordinator address until we've deployed the contract and added
    // the address to `@0x/contract-addresses`
    COORDINATOR_CONTRACT_ADDRESS: '0x4d3d5c850dd5bd9d6f4adda3dd039a3c8054ca29',
    COORDINATOR_DOMAIN_NAME: '0x Protocol Coordinator',
    COORDINATOR_DOMAIN_VERSION: '1.0.0',
    COORDINATOR_APPROVAL_SCHEMA: {
        name: 'CoordinatorApproval',
        parameters: [
            { name: 'txOrigin', type: 'address' },
            { name: 'transactionHash', type: 'bytes32' },
            { name: 'transactionSignature', type: 'bytes' },
            { name: 'approvalExpirationTimeSeconds', type: 'uint256' },
        ],
    },
    DEFAULT_NETWORK_ID: 1,
};
