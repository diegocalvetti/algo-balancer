<script lang="ts">
  import CreatePoolSteps from "$lib/components/create-pool/CreatePoolSteps.svelte";
  import InputTokens from "$lib/components/InputTokens.svelte";
  import {getTokens} from "$lib/tokens";
  import InputWeight from "$lib/components/InputWeight.svelte";
  import NextStep from "$lib/components/create-pool/NextStep.svelte";
  import {txCreatePool, txInitPool} from "$lib/algorand";

  let selectedTokens: bigint[] = $state([BigInt(1024)]);
  let selectedWeights: number[] = $state([]);
  let step = $state(0);

  async function nextStep() {
    step = step + 1;

    if (step == 1) {
      selectedWeights = selectedTokens.map(_ => 1/selectedTokens.length * 100)
    }
  }

  async function addToken() {
    selectedTokens = [...selectedTokens, await getTokenToAdd()];
  }

  async function getTokenToAdd(): Promise<bigint> {
    const tokens = await getTokens();
    return tokens.filter(token => !selectedTokens.includes(token.id)).reverse()[0].id;
  }

  function removeToken(id: bigint) {
    selectedTokens = [...selectedTokens.filter(el => el !== id)];
  }

  let poolID = $state(BigInt(0));

  async function createPool() {
    poolID = await txCreatePool();
    console.log('pool id', poolID);
  }

  async function initPool() {
    await txInitPool(poolID!, selectedTokens, selectedWeights);
    console.log("end")
  }
</script>
<div class="columns is-multiline">
  <div class="column is-12">
    Create Pool
  </div>
</div>
<div class="columns is-multiline">
  <div class="column is-12">
    <CreatePoolSteps active={step} />
  </div>
  <div class="column is-8 mx-auto">
    {#if step === 0}
      <div class="box">
      {#each selectedTokens as _, index}
        <div class="box token-box-container">
          <InputTokens selectedTokens={selectedTokens} bind:selected={selectedTokens[index]} deleteToken={removeToken} opened={false} readonly={false}/>
        </div>
      {/each}
      <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions (because of reasons) -->
      <div class="box token-box-add" onclick={addToken}>
        <span class="icon m-auto">
          <i class="fa-solid fa-plus"></i>
        </span>
      </div>
      <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions (because of reasons) -->
      <NextStep disabled={selectedTokens.length < 2} click={nextStep} />
    </div>
    {/if}

    {#if step === 1}
      <div class="box">
        {#each selectedTokens as _, index}
          <div class="box token-box-container-weights">
            <InputTokens readonly={true} selectedTokens={selectedTokens} bind:selected={selectedTokens[index]} deleteToken={removeToken} opened={false}/>
            <InputWeight bind:selected="{selectedWeights[index]}"/>
          </div>
        {/each}

        <NextStep click={nextStep} />
      </div>
    {/if}

    {#if step === 2}
      <div class="box">
        <p>Recap</p>
        <div class="columns is-multiline">
          {#each selectedTokens as _, index}
            <div class="column is-6">
              <div class="box token-box-container-weights">
                <InputTokens readonly={true} selectedTokens={selectedTokens} bind:selected={selectedTokens[index]} deleteToken={removeToken} opened={false}/>
                <InputWeight readonly={true} bind:selected="{selectedWeights[index]}"/>
              </div>
            </div>
          {/each}
        </div>
        <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions (because of reasons) -->
        <div class="box token-box-next has-text-centered is-info" onclick={createPool}>
          <p>
            <b>Create Pool</b>
          </p>
        </div>
        <div class="box token-box-next has-text-centered is-info" onclick={initPool}>
          <p>
            <b>Init Pool</b>
          </p>
        </div>
      </div>
      <NextStep disabled={true} onclick={nextStep} />
    {/if}
  </div>
</div>
