<script lang="ts">
	import type { Snippet } from 'svelte';
	import { enhance } from '$app/forms';
	import * as AlertDialog from '$lib/components/ui/alert-dialog/index.js';
	import { Button, buttonVariants } from '$lib/components/ui/button/index.js';
	import { cn } from '$lib/utils.js';

	type Props = {
		action: 'reboot' | 'poweroff';
		title: string;
		description: string;
		confirmLabel: string;
		variant?: 'outline' | 'destructive';
		children: Snippet;
	};

	let { action, title, description, confirmLabel, variant = 'outline', children }: Props = $props();

	let open = $state(false);
	let pending = $state(false);
</script>

<AlertDialog.Root bind:open>
	<AlertDialog.Trigger class={cn(buttonVariants({ variant }), 'w-full justify-start')} disabled={pending}>
		{@render children()}
	</AlertDialog.Trigger>
	<AlertDialog.Content>
		<!-- Plain submit button rather than AlertDialog.Action so closing the dialog can't race the submit -->
		<form
			method="POST"
			action="?/{action}"
			use:enhance={() => {
				pending = true;
				return async ({ update }) => {
					try {
						await update();
					} finally {
						pending = false;
						open = false;
					}
				};
			}}
		>
			<AlertDialog.Header>
				<AlertDialog.Title>{title}</AlertDialog.Title>
				<AlertDialog.Description>{description}</AlertDialog.Description>
			</AlertDialog.Header>
			<AlertDialog.Footer class="mt-6">
				<AlertDialog.Cancel type="button" disabled={pending}>Cancel</AlertDialog.Cancel>
				<Button type="submit" variant="destructive" disabled={pending}>
					{pending ? 'Sending…' : confirmLabel}
				</Button>
			</AlertDialog.Footer>
		</form>
	</AlertDialog.Content>
</AlertDialog.Root>
