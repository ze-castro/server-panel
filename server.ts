// Production entry: SvelteKit's adapter-node handler + the terminal WebSocket on one port.
import { createServer } from 'node:http';
import { handler } from './build/handler.js';
import { handleUpgrade } from './src/lib/server/terminal-ws.ts';

const port = Number(process.env.PORT ?? 3010);
const host = process.env.HOST ?? '0.0.0.0';

const server = createServer(handler);

server.on('upgrade', (req, socket, head) => {
	handleUpgrade(req, socket, head).then(
		(handled) => handled || socket.destroy(),
		(err) => {
			console.error('[upgrade]', err);
			socket.destroy();
		}
	);
});

server.listen(port, host, () => console.log(`Listening on http://${host}:${port}`));

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
	process.on(signal, () => {
		server.close(() => process.exit(0));
		setTimeout(() => process.exit(0), 5_000).unref(); // open terminal sessions keep close() pending
	});
}
