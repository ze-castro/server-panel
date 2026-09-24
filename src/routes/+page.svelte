<script lang="ts">
  import ControlPanel from '$lib/components/ControlPanel.svelte';
  import Workspace from '$lib/components/Workspace.svelte';
  import type { PageProps } from './$types';

  let { form }: PageProps = $props();
</script>

<svelte:head><title>Server</title></svelte:head>

<main class="grid min-h-dvh lg:h-dvh lg:grid-cols-[22rem_minmax(0,1fr)] lg:overflow-hidden">
  <ControlPanel result={form} />
  <Workspace />
</main>
