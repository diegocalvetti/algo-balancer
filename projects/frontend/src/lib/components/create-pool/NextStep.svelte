<script lang="ts">
  type Props = {
    disabled?: boolean,
    click: any,
  }
  let { disabled = false, click } : Props = $props();
</script>
<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions (because of reasons) -->
<div class="box token-box-next has-text-centered is-info" onclick={click} class:is-disabled={disabled}>
  <p>
    <b>Next Step</b>
  </p>
</div>
