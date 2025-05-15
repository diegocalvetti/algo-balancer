<script>
  let steps = [
    'Select Assets',
    'Setup the Weights',
    'Create the Pool',
    'Add the Liquidity'
  ]

  let { active = 0 } = $props();
</script>

<ul class="steps has-content-centered" style="width: 80%; margin:auto">
  {#each steps as step, index}
    <li class="steps-segment" class:is-active={steps[active] === step}>
      <span class="steps-marker">{index + 1}</span>
      <div class="steps-content">
        <p class="is-size-6">{step}</p>
      </div>
    </li>
  {/each}
</ul>
