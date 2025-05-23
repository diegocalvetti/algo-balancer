import {
    WalletManager,
    WalletId,
    NetworkConfigBuilder,
    NetworkId,
    LogLevel,
} from '@txnlab/use-wallet'

// Configure networks
const networks = new NetworkConfigBuilder()
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
        WalletId.MNEMONIC,
        WalletId.DEFLY,
        WalletId.MNEMONIC,
      {
        id: WalletId.MNEMONIC,
        options: {
          persistToStorage: true,        // Optional: Save mnemonic in localStorage
        }
      }
    ],

    // Use custom network configurations
    networks,
    defaultNetwork: NetworkId.LOCALNET,

    // Set manager options
    options: {
        debug: true,
        logLevel: LogLevel.INFO,
        resetNetwork: true,
    }
})
