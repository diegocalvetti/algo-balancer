<script lang="ts">
  let {selected = $bindable(), readonly = false} = $props()

  let value = $derived(parseFloat(selected).toFixed(3))
</script>
<div class="input-box">
  <input class="input" value={value} readonly={readonly}>
</div>
