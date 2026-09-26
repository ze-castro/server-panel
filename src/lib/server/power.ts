import { exec } from './ssh';

// Must match the sudoers rule exactly (see README).
const COMMANDS = {
	reboot: 'sudo -n /usr/bin/systemctl reboot',
	poweroff: 'sudo -n /usr/bin/systemctl poweroff'
} as const;

export type PowerAction = keyof typeof COMMANDS;

export async function power(
	action: PowerAction
): Promise<{ ok: true } | { ok: false; message: string }> {
	try {
		const { code, stderr } = await exec(COMMANDS[action], { timeoutMs: 30_000 });
		// null = channel closed before an exit status arrived, i.e. the host is already going down.
		if (code === 0 || code === null) return { ok: true };
		return { ok: false, message: stderr.trim() || `Command exited with code ${code}` };
	} catch (err) {
		return { ok: false, message: err instanceof Error ? err.message : String(err) };
	}
}
