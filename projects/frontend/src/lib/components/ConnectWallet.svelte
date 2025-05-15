<script lang="ts">
    import { walletManager } from '$lib/wallet'
    import { onMount } from 'svelte'
    import { BaseWallet, WalletId } from "@txnlab/use-wallet";

    let account: string | null = null
    export let WALLET : BaseWallet | undefined

    onMount(() => {
        WALLET = walletManager.getWallet(WalletId.LUTE)
        const active = walletManager.activeAccount
        account = active?.address ?? null
        console.log(active)
    })

    async function connect() {
        if (!WALLET) return
        await WALLET.connect()
        account = walletManager.activeAccount?.address ?? null
    }

    async function disconnect() {
        if (!WALLET) return
        await WALLET.disconnect()
        account = null
    }

    const shorter_addr = (addr : String) => {
        const len = addr.length
        return addr.substring(0, 5) + "..." + addr.substring(len - 5, len)
    }

    let menu_dropdown = false

    const open_menu_dropdown = () => {
        menu_dropdown = !menu_dropdown
    }
</script>

{#if account}
    <div class="dropdown" class:is-active={menu_dropdown}>
        <div class="dropdown-trigger" on:click={open_menu_dropdown}>
            <button class="button">
                <span>{shorter_addr(account)}</span>
                <span class="icon">
                  <i class="fa-solid fa-wallet"></i>
                </span>
            </button>
        </div>
        <div class="dropdown-menu" id="dropdown-menu" role="menu">
            <div class="dropdown-content">
                <button class="button is-fullwidth is-danger" on:click={disconnect}>
                    Disconnect
                </button>
            </div>
        </div>
    </div>
{:else}
    <button class="button is-warning" on:click={connect}>
    <span class="icon">
      <img src="/images/pera.png" class="w-80" alt="Logo" />
    </span>
        <span>Connetti un wallet</span>
    </button>
{/if}
