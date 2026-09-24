import { fail } from '@sveltejs/kit';
import { power, type PowerAction } from '$lib/server/power';
import type { Actions } from './$types';

const MESSAGES: Record<PowerAction, string> = {
	reboot: 'Restart requested. The terminal reconnects once the server is back.',
	poweroff: 'Shutdown requested. The server is powering off.'
};

async function run(action: PowerAction) {
	const result = await power(action);
	if (!result.ok) return fail(500, { ok: false as const, message: result.message });
	return { ok: true as const, message: MESSAGES[action] };
}

export const actions: Actions = {
	reboot: () => run('reboot'),
	poweroff: () => run('poweroff')
};
