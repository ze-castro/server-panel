// Plain process.env (no $env/$lib imports): this module is also loaded by server.ts outside SvelteKit.
function required(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`Missing env var ${name}`);
	return value;
}

export type SshEnv = {
	host: string;
	port: number;
	username: string;
	keyPath: string;
	keyPassphrase: string | undefined;
	hostKeySha256: string;
};

let cached: SshEnv | undefined;

// Lazy so `vite build` (which imports server modules) doesn't need runtime env vars.
export function sshEnv(): SshEnv {
	cached ??= {
		host: required('SSH_HOST'),
		port: Number(process.env.SSH_PORT ?? 22),
		username: required('SSH_USER'),
		keyPath: required('SSH_KEY_PATH'),
		keyPassphrase: process.env.SSH_KEY_PASSPHRASE || undefined,
		hostKeySha256: required('SSH_HOST_KEY_SHA256')
	};
	return cached;
}
