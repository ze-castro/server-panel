import { Client, type ConnectConfig } from 'ssh2';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { sshEnv } from './env';

// Same format as `ssh-keygen -lf`: "SHA256:<unpadded base64>"
function fingerprint(key: Buffer): string {
	return 'SHA256:' + createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
}

function readPrivateKey(path: string): Buffer {
	try {
		return readFileSync(path);
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === 'EISDIR')
			throw new Error(`SSH_KEY_PATH is a directory (${path}); point it at the private key file`);
		if (code === 'ENOENT')
			throw new Error(`SSH_KEY_PATH not found: ${path} (use an absolute path; ~ isn't expanded)`);
		throw err;
	}
}

function connectConfig(): ConnectConfig {
	const ssh = sshEnv();
	return {
		host: ssh.host,
		port: ssh.port,
		username: ssh.username,
		privateKey: readPrivateKey(ssh.keyPath),
		passphrase: ssh.keyPassphrase,
		// Pin to ed25519 so the fingerprint we compare against is the key the server presents.
		algorithms: { serverHostKey: ['ssh-ed25519'] },
		hostVerifier: (key: Buffer) => {
			const actual = fingerprint(key);
			if (actual !== ssh.hostKeySha256) {
				console.error(
					`[ssh] host key mismatch: server presented ${actual}, SSH_HOST_KEY_SHA256 is ${ssh.hostKeySha256}`
				);
			}
			return actual === ssh.hostKeySha256;
		},
		readyTimeout: 10_000,
		keepaliveInterval: 15_000
	};
}

export function connect(): Promise<Client> {
	return new Promise((resolve, reject) => {
		const client = new Client();
		let ready = false;
		client
			.on('ready', () => {
				ready = true;
				resolve(client);
			})
			// Persistent listener: an 'error' with no listener would crash the process.
			.on('error', (err) => {
				if (!ready) reject(err);
				else console.error('[ssh]', err.message);
			})
			.connect(connectConfig());
	});
}

// One long-lived connection for short exec calls (stats, power actions).
let shared: Promise<Client> | undefined;

function sharedClient(): Promise<Client> {
	if (!shared) {
		const pending = connect();
		shared = pending;
		pending.then(
			(client) => client.once('close', () => shared === pending && (shared = undefined)),
			() => shared === pending && (shared = undefined)
		);
	}
	return shared;
}

export type ExecResult = { stdout: string; stderr: string; code: number | null };

type ExecOptions = {
	timeoutMs?: number;
	/** Written to the command's stdin, then closed. */
	stdin?: string;
};

/** `code` is null when the channel closed without an exit status (e.g. host went down). */
export async function exec(
	command: string,
	{ timeoutMs = 10_000, stdin }: ExecOptions = {}
): Promise<ExecResult> {
	const client = await sharedClient();
	return new Promise((resolve, reject) => {
		client.exec(command, (err, stream) => {
			if (err) return reject(err);
			let stdout = '';
			let stderr = '';
			let code: number | null = null;
			const timer = setTimeout(() => {
				stream.close();
				reject(new Error(`Timed out after ${timeoutMs}ms: ${command}`));
			}, timeoutMs);
			stream.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
			stream.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
			stream.on('exit', (exitCode: number | null) => (code = exitCode));
			stream.on('close', () => {
				clearTimeout(timer);
				resolve({ stdout, stderr, code });
			});
			if (stdin !== undefined) stream.end(stdin);
		});
	});
}

/**
 * Runs a POSIX sh script regardless of the user's login shell (fish, nushell...):
 * SSH exec goes through the login shell, so the script is piped into `sh -s` instead.
 */
export function execScript(script: string, options: Omit<ExecOptions, 'stdin'> = {}) {
	return exec('sh -s', { ...options, stdin: script });
}

/** Splits script output into sections marked by lines starting with '@name'. */
export function splitSections(output: string): Map<string, string[]> {
	const map = new Map<string, string[]>();
	let current: string[] | undefined;
	for (const line of output.split('\n')) {
		if (line.startsWith('@')) map.set(line.slice(1).trim(), (current = []));
		else if (current && line.trim() !== '') current.push(line);
	}
	return map;
}
