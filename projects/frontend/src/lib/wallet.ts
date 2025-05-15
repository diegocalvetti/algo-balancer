import {
    WalletManager,
    WalletId,
    NetworkConfigBuilder,
    NetworkId,
    LogLevel,
} from '@txnlab/use-wallet'

// Configure networks
const networks = new NetworkConfigBuilder()
    .testnet({
        algod: {
            baseServer: 'https://testnet-api.algonode.cloud',
            port: '443',
            token: ''
        }
    })
    .localnet({
        algod: {
            baseServer: 'http://localhost',
            port: '4001',
            token: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
        }
    })
    .build()

// Create manager instance
export const walletManager = new WalletManager({
    // Configure wallets
    wallets: [
        WalletId.PERA,
        WalletId.DEFLY,
        WalletId.LUTE,
    ],

    // Use custom network configurations
    networks,
    defaultNetwork: NetworkId.LOCALNET,

    // Set manager options
    options: {
        debug: true,
        logLevel: LogLevel.INFO,
        resetNetwork: false,
    }
})
