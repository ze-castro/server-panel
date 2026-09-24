import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { Client, ClientChannel } from 'ssh2';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import { connect } from './ssh';

export const TERMINAL_PATH = '/ws/terminal';

const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

function reject(socket: Duplex, status: string): true {
	socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
	return true;
}

// Blocks cross-site WebSocket hijacking: a malicious page could otherwise open a terminal using
// your Cloudflare Access cookie, since browsers send cookies on cross-origin WebSocket requests.
function sameOrigin(req: IncomingMessage): boolean {
	const origin = req.headers.origin;
	if (!origin) return false;
	try {
		return new URL(origin).host === req.headers.host;
	} catch {
		return false;
	}
}

/** Returns false if the request isn't for the terminal, so the caller can pass it on. */
export async function handleUpgrade(
	req: IncomingMessage,
	socket: Duplex,
	head: Buffer
): Promise<boolean> {
	const url = new URL(req.url ?? '/', 'http://localhost');
	if (url.pathname !== TERMINAL_PATH) return false;

	if (!sameOrigin(req)) return reject(socket, '403 Forbidden');

	wss.handleUpgrade(req, socket, head, (ws) => void startSession(ws, url));
	return true;
}

function dimension(value: string | null | undefined, fallback: number): number {
	const n = Number(value);
	return Number.isInteger(n) && n > 0 && n <= 1000 ? n : fallback;
}

function toBuffer(data: RawData): Buffer {
	if (Buffer.isBuffer(data)) return data;
	if (Array.isArray(data)) return Buffer.concat(data);
	return Buffer.from(data);
}

function handleMessage(stream: ClientChannel, data: RawData, isBinary: boolean): void {
	// Binary frames = keystrokes; text frames = JSON control messages.
	if (isBinary) return void stream.write(toBuffer(data));
	try {
		const msg = JSON.parse(toBuffer(data).toString()) as {
			type?: string;
			cols?: unknown;
			rows?: unknown;
		};
		if (msg.type === 'resize') {
			const cols = dimension(String(msg.cols), 0);
			const rows = dimension(String(msg.rows), 0);
			if (cols && rows) stream.setWindow(rows, cols, 0, 0);
		}
	} catch {
		// ignore malformed control messages
	}
}

const MAX_QUEUED_MESSAGES = 256;

async function startSession(ws: WebSocket, url: URL): Promise<void> {
	let client: Client | undefined;
	let stream: ClientChannel | undefined;
	let closed = false;

	// Input can arrive before the SSH shell is ready; queue it instead of dropping it.
	const queue: [RawData, boolean][] = [];
	ws.on('message', (data, isBinary) => {
		if (stream) handleMessage(stream, data, isBinary);
		else if (queue.length < MAX_QUEUED_MESSAGES) queue.push([data, isBinary]);
	});

	// Heartbeat: detects dead peers and keeps idle sessions from being cut by proxies.
	let alive = true;
	ws.on('pong', () => (alive = true));
	const heartbeat = setInterval(() => {
		if (!alive) return ws.terminate();
		alive = false;
		ws.ping();
	}, 30_000);

	ws.once('close', () => {
		closed = true;
		clearInterval(heartbeat);
		client?.end();
	});

	try {
		client = await connect();
	} catch (err) {
		console.error('[terminal] ssh connect failed', err);
		ws.close(1011, 'SSH connection failed');
		return;
	}
	// The browser may have gone away while we were connecting.
	if (closed) return void client.end();

	const cols = dimension(url.searchParams.get('cols'), 80);
	const rows = dimension(url.searchParams.get('rows'), 24);

	client.shell({ term: 'xterm-256color', cols, rows }, (err, channel) => {
		if (err) {
			ws.close(1011, 'Could not start a shell');
			return;
		}
		const forward = (chunk: Buffer) => ws.readyState === ws.OPEN && ws.send(chunk);
		channel.on('data', forward);
		channel.stderr.on('data', forward);
		channel.on('close', () => ws.close(1000, 'Shell exited'));

		stream = channel;
		for (const [data, isBinary] of queue.splice(0)) handleMessage(channel, data, isBinary);
	});
}
