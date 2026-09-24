<script lang="ts">
	import LogsPanel from './LogsPanel.svelte';
	import Terminal from './Terminal.svelte';

	const TABS = [
		{ id: 'terminal', label: 'Terminal' },
		{ id: 'logs', label: 'Logs' }
	] as const;

	let tab = $state<(typeof TABS)[number]['id']>('terminal');
</script>

<section class="flex min-h-[70dvh] min-w-0 flex-col bg-zinc-950 text-zinc-300 lg:min-h-0">
	<div class="flex gap-1 border-b border-white/10 px-2 pt-2" role="tablist">
		{#each TABS as t (t.id)}
			<button
				type="button"
				role="tab"
				id="tab-{t.id}"
				aria-selected={tab === t.id}
				aria-controls="panel-{t.id}"
				class={[
					'-mb-px border-b-2 px-3 pb-2 text-sm transition-colors',
					tab === t.id ? 'border-zinc-100 text-zinc-100' : 'border-transparent text-zinc-500 hover:text-zinc-300'
				]}
				onclick={() => (tab = t.id)}
			>
				{t.label}
			</button>
		{/each}
	</div>

	<!-- Both panels stay mounted (hidden, not removed) so the terminal session survives tab switches. -->
	<div id="panel-terminal" role="tabpanel" aria-labelledby="tab-terminal" class={['min-h-0 flex-1', tab !== 'terminal' && 'hidden']}>
		<Terminal />
	</div>
	<div id="panel-logs" role="tabpanel" aria-labelledby="tab-logs" class={['min-h-0 flex-1', tab !== 'logs' && 'hidden']}>
		<LogsPanel active={tab === 'logs'} />
	</div>
</section>
