<script lang="ts">
  import {getPools} from "$lib/algorand.js";
  import {onMount} from "svelte";

  let pools: any = [];

  onMount(async () => {
    pools = await getPools();
    console.log(pools);
  })
</script>
<div class="columns is-multiline">
  <div class="column is-12">
    Pool
  </div>
</div>
<div class="columns">
  {#each pools as pool}
    <div class="column is-4">
      <a class="box is-clickable" href="/pool/{pool.id}">
        {pool.id}
        {#each pool.assets as asset}
          <span>{asset.unit} ({asset.weight})/</span>
        {/each}
      </a>
    </div>
  {/each}
</div>
