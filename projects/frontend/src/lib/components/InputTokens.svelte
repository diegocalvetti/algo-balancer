<script lang="ts">
  import { onMount } from "svelte";
  import { type Asset } from "$lib/algorand";
  import { getTokensWithout } from "$lib/tokens";

  let tokens: Asset[] = $state([]);

  const activeToken = $derived(tokens.find(el => el.id === selected))

  onMount(async () => {
    tokens = await getTokensWithout(selectedTokens.filter(el => el !== selected));
  })

  const selectToken = (id: bigint) => {
    selected = id;
    open(false)
  }

  const open = async (yes = true) => {
    if (yes) {
      tokens = await getTokensWithout(selectedTokens.filter(el => el !== selected));
    }
    opened = yes;
  }

  let { deleteToken, selectedTokens, selected = $bindable(), opened = false, readonly = false }: {deleteToken: any, selectedTokens: bigint[], selected: bigint, opened: boolean, readonly: boolean} = $props();
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions (because of reasons) -->
<div class="box token-box" class:is-clickable={!readonly} on:click={() => {if (!readonly) {open(true)}}}>
  <img alt="token icon" src={`/images/tokens/${activeToken ? activeToken.icon : ""}.png`} />
  <div>
    <p class="is-info"><b>{activeToken ? activeToken.name : 'nope'}</b></p>
    <p><i>${activeToken ? activeToken.unit : 'NONE'}</i></p>
  </div>
  {#if selectedTokens.length >= 2 && !readonly}
    <span class="icon ml-auto my-auto" on:click|stopPropagation={() => deleteToken(activeToken?.id)}>
     <i class="fa-solid fa-trash"></i>
    </span>
  {/if}
</div>

<div class="modal" class:is-active={opened}>
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions (because of reasons) -->
  <div class="modal-background" on:click={() => open(false)}></div>
  <div class="modal-content">
    <div class="box">
      {#each tokens as token}
        <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions (because of reasons) -->
        <div aria-required="false" class="box token-select-box" on:click={() => selectToken(token.id)}>
          <p>{token.name}</p>
          <p>{token.unit}</p>
        </div>
      {/each}
    </div>
  </div>
  <button class="modal-close is-large" aria-label="close" on:click={() => open(false)}></button>
</div>
