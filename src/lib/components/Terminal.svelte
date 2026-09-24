<script lang="ts">
	import '@xterm/xterm/css/xterm.css';
	import { Button } from '$lib/components/ui/button/index.js';

	type Status = 'connecting' | 'open' | 'closed';

	let container: HTMLDivElement;
	let status = $state<Status>('connecting');
	let closeReason = $state('');
	let attempt = $state(0); // bump to reconnect

	$effect(() => {
		void attempt;
		let disposed = false;
		let cleanup = () => {};

		(async () => {
			// xterm touches `window` on import, so load it client-side only.
			const [{ Terminal }, { FitAddon }] = await Promise.all([
				import('@xterm/xterm'),
				import('@xterm/addon-fit')
			]);
			if (disposed) return;

			const term = new Terminal({
				cursorBlink: true,
				fontFamily: 'ui-monospace, "SF Mono", Menlo, Consolas, "DejaVu Sans Mono", monospace',
				fontSize: 13,
				scrollback: 5_000,
				theme: { background: '#09090b', foreground: '#e4e4e7', cursor: '#e4e4e7' }
			});
			const fit = new FitAddon();
			term.loadAddon(fit);
			term.open(container);
			// While the Logs tab is shown the container is display:none; fitting then would shrink the shell to 2 columns.
			const safeFit = () => container.clientWidth > 0 && container.clientHeight > 0 && fit.fit();
			safeFit();

			status = 'connecting';
			const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
			const ws = new WebSocket(`${scheme}://${location.host}/ws/terminal?cols=${term.cols}&rows=${term.rows}`);
			ws.binaryType = 'arraybuffer';
			const encoder = new TextEncoder();

			ws.onopen = () => {
				status = 'open';
				term.focus();
			};
			ws.onmessage = (e) => term.write(new Uint8Array(e.data as ArrayBuffer));
			ws.onclose = (e) => {
				status = 'closed';
				closeReason = e.reason || 'Disconnected';
				term.options.cursorBlink = false;
			};

			const input = term.onData((data) => {
				if (ws.readyState === WebSocket.OPEN) ws.send(encoder.encode(data));
			});
			const resize = term.onResize(({ cols, rows }) => {
				if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'resize', cols, rows }));
			});

			let frame = 0;
			const observer = new ResizeObserver(() => {
				cancelAnimationFrame(frame);
				frame = requestAnimationFrame(safeFit);
			});
			observer.observe(container);

			cleanup = () => {
				cancelAnimationFrame(frame);
				observer.disconnect();
				input.dispose();
				resize.dispose();
				ws.close();
				term.dispose();
			};
		})();

		return () => {
			disposed = true;
			cleanup();
		};
	});

	const label = $derived(status === 'open' ? 'Connected' : status === 'connecting' ? 'Connecting…' : closeReason);
</script>

<div class="flex h-full min-h-0 flex-col">
	<div class="flex h-11 items-center gap-2.5 border-b border-white/10 px-4 text-sm">
		<span
			class={[
				'size-2 rounded-full',
				status === 'open' && 'bg-emerald-500',
				status === 'connecting' && 'animate-pulse bg-amber-500',
				status === 'closed' && 'bg-zinc-600'
			]}
			aria-hidden="true"
		></span>
		<span role="status">{label}</span>
		{#if status === 'closed'}
			<Button size="sm" variant="secondary" class="ml-auto" onclick={() => attempt++}>Reconnect</Button>
		{/if}
	</div>
	<div class="min-h-0 flex-1 p-3">
		<div bind:this={container} class="h-full"></div>
	</div>
</div>
