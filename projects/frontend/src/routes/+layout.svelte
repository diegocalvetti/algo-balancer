<!-- +layout.svelte -->
<script lang="ts">
  import "$lib/assets/scss/app.scss";
  import { page } from '$app/state';
  import ConnectWallet from "$lib/components/ConnectWallet.svelte";
</script>

<header>
    <nav class="navbar has-background-transparent">
        <div class="navbar-brand">

            <a role="button" class="navbar-burger" aria-label="menu" aria-expanded="false" data-target="navbarBasicExample">
                <span aria-hidden="true"></span>
                <span aria-hidden="true"></span>
                <span aria-hidden="true"></span>
                <span aria-hidden="true"></span>
            </a>
        </div>

        <div class="navbar-menu">
            <div class="navbar-start">
                <a href="/" class="navbar-item" class:active={page.url.pathname === '/'}>
                    Dashboard
                </a>
                <a href="/pools" class="navbar-item" class:active={page.url.pathname === '/'}>
                    Pools
                </a>
            </div>
            <div class="navbar-end">
                <span class="navbar-item">
                    <ConnectWallet />
                </span>
            </div>
        </div>
    </nav>
</header>

<main class="mx-5">
    <slot />
</main>
