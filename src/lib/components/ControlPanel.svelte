<script lang="ts">
	import PowerIcon from '@lucide/svelte/icons/power';
	import RotateCwIcon from '@lucide/svelte/icons/rotate-cw';
	import Meter from './Meter.svelte';
	import PowerButton from './PowerButton.svelte';
	import { bytes, duration, percent } from '$lib/format';
	import type { Gpu, Stats } from '$lib/types';

	let { result }: { result: { ok: boolean; message: string } | null | undefined } = $props();

	const POLL_MS = 3_000;

	let stats = $state<Stats | null>(null);
	let error = $state<string | null>(null);

	$effect(() => {
		let stopped = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const controller = new AbortController();

		async function poll() {
			if (document.visibilityState === 'visible') {
				try {
					const res = await fetch('/api/stats', { signal: controller.signal });
					const body = await res.json();
					if (res.ok) {
						stats = body as Stats;
						error = null;
					} else {
						error = body.message ?? `Stats request failed (${res.status}).`;
					}
				} catch {
					if (stopped) return;
					// Also hit when the Cloudflare Access session expires (the redirect to login fails the fetch).
					error = 'Stats unavailable. If this persists, reload the page to sign in again.';
				}
			}
			if (!stopped) timer = setTimeout(poll, POLL_MS);
		}

		poll();
		return () => {
			stopped = true;
			controller.abort();
			clearTimeout(timer);
		};
	});

	// Utilization when the driver reports it; otherwise current clock relative to max as a rough load indicator.
	function gpuValue(gpu: Gpu): number {
		if (gpu.busyPercent !== null) return gpu.busyPercent;
		if (gpu.freqMhz !== null && gpu.maxFreqMhz) return percent(gpu.freqMhz, gpu.maxFreqMhz);
		return 0;
	}

	function gpuDetail(gpu: Gpu): string {
		const parts: string[] = [];
		if (gpu.busyPercent !== null) parts.push(`${gpu.busyPercent.toFixed(0)}%`);
		if (gpu.freqMhz !== null) parts.push(`${gpu.freqMhz} MHz`);
		if (gpu.temperatureC !== null) parts.push(`${gpu.temperatureC.toFixed(0)} °C`);
		return parts.join(', ') || 'No data';
	}

	const stateColor = (state: string) =>
		state === 'running' ? 'bg-emerald-500' : state === 'exited' ? 'bg-muted-foreground/40' : 'bg-amber-500';
</script>

<aside class="flex flex-col gap-7 overflow-y-auto border-b p-5 lg:border-r lg:border-b-0">
	<header class="space-y-1">
		<h1 class="text-xl font-semibold tracking-tight">{stats?.hostname ?? (error ? 'Server unreachable' : 'Connecting…')}</h1>
		{#if stats}
			<p class="text-muted-foreground text-sm">
				Up {duration(stats.uptimeSeconds)}, kernel {stats.kernel}
			</p>
		{/if}
	</header>

	{#if error}
		<p class="text-destructive text-sm" role="status">{error}</p>
	{/if}

	{#if stats}
		<section class="space-y-4" aria-labelledby="resources-heading">
			<h2 id="resources-heading" class="text-sm font-medium">Resources</h2>
			<Meter label="CPU ({stats.cores} cores)" value={stats.cpuPercent} detail="{stats.cpuPercent.toFixed(0)}%" />
			{#each stats.gpus as gpu, i (i)}
				<Meter label={gpu.name} value={gpuValue(gpu)} detail={gpuDetail(gpu)} />
				{#if gpu.vram}
					<Meter
						label="{gpu.name} memory"
						value={percent(gpu.vram.used, gpu.vram.total)}
						detail="{bytes(gpu.vram.used)} of {bytes(gpu.vram.total)}"
					/>
				{/if}
			{/each}
			<Meter
				label="Memory"
				value={percent(stats.memory.used, stats.memory.total)}
				detail="{bytes(stats.memory.used)} of {bytes(stats.memory.total)}"
			/>
			{#if stats.swap.total > 0}
				<Meter
					label="Swap"
					value={percent(stats.swap.used, stats.swap.total)}
					detail="{bytes(stats.swap.used)} of {bytes(stats.swap.total)}"
				/>
			{/if}
			{#each stats.disks as disk (disk.mount)}
				<Meter
					label="Disk {disk.mount}"
					value={percent(disk.used, disk.total)}
					detail="{bytes(disk.used)} of {bytes(disk.total)}"
				/>
			{/each}

			<dl class="grid grid-cols-2 gap-x-4 gap-y-2 pt-1 text-sm">
				<dt class="text-muted-foreground">Load</dt>
				<dd class="text-right tabular-nums">{stats.load.map((n) => n.toFixed(2)).join('  ')}</dd>
				<dt class="text-muted-foreground">Download</dt>
				<dd class="text-right tabular-nums">{bytes(stats.network.rxBytesPerSec)}/s</dd>
				<dt class="text-muted-foreground">Upload</dt>
				<dd class="text-right tabular-nums">{bytes(stats.network.txBytesPerSec)}/s</dd>
			</dl>
		</section>

		<section class="space-y-3" aria-labelledby="containers-heading">
			<h2 id="containers-heading" class="text-sm font-medium">Containers</h2>
			{#if stats.containers === null}
				<p class="text-muted-foreground text-sm">Add the SSH user to the docker group to list containers.</p>
			{:else if stats.containers.length === 0}
				<p class="text-muted-foreground text-sm">No containers on this host.</p>
			{:else}
				<ul class="space-y-2 text-sm">
					{#each stats.containers as c (c.name)}
						<li class="flex items-center gap-2.5" title={c.image}>
							<span class={['size-2 shrink-0 rounded-full', stateColor(c.state)]} aria-hidden="true"></span>
							<span class="truncate">{c.name}</span>
							<span class="text-muted-foreground ml-auto shrink-0 text-xs">{c.status}</span>
						</li>
					{/each}
				</ul>
			{/if}
		</section>
	{/if}

	<section class="mt-auto space-y-2 border-t pt-5" aria-labelledby="power-heading">
		<h2 id="power-heading" class="sr-only">Power</h2>
		<PowerButton
			action="reboot"
			title="Restart the server?"
			description="Everything on the host restarts, including this panel. The terminal disconnects and can reconnect once the server is back."
			confirmLabel="Restart"
		>
			<RotateCwIcon /> Restart server
		</PowerButton>
		<PowerButton
			action="poweroff"
			variant="destructive"
			title="Shut down the server?"
			description="The host powers off and this panel goes offline with it. Turning it back on needs physical or out-of-band access."
			confirmLabel="Shut down"
		>
			<PowerIcon /> Shut down server
		</PowerButton>

		{#if result}
			<p class={['text-sm', result.ok ? 'text-muted-foreground' : 'text-destructive']} role="status">
				{result.message}
			</p>
		{/if}
	</section>
</aside>
