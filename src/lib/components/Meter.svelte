<script lang="ts">
	import { Progress } from '$lib/components/ui/progress/index.js';

	let { label, value, detail }: { label: string; value: number; detail: string } = $props();
</script>

<div class="space-y-1.5">
	<div class="flex items-baseline justify-between gap-3 text-sm">
		<span class="text-muted-foreground truncate">{label}</span>
		<span class={['shrink-0 tabular-nums', value >= 90 && 'text-destructive']}>{detail}</span>
	</div>
	<Progress value={Math.min(value, 100)} max={100} class="h-1.5" />
</div>
