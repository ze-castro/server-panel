import tailwindcss from '@tailwindcss/vite';
import adapter from '@sveltejs/adapter-node';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig, loadEnv, type Plugin } from 'vite';

// Dev-only: attach the terminal WebSocket to Vite's HTTP server. Production uses server.ts.
function terminalWebSocket(): Plugin {
	return {
		name: 'terminal-websocket',
		apply: 'serve',
		configureServer(server) {
			server.httpServer?.on('upgrade', async (req, socket, head) => {
				if (!req.url?.startsWith('/ws/terminal')) return; // leave HMR alone
				try {
					const mod = (await server.ssrLoadModule(
						'/src/lib/server/terminal-ws.ts'
					)) as typeof import('./src/lib/server/terminal-ws');
					await mod.handleUpgrade(req, socket, head);
				} catch (err) {
					console.error(err);
					socket.destroy();
				}
			});
		}
	};
}

export default defineConfig(({ mode }) => {
	// Server modules read process.env directly (they also run outside SvelteKit), and Vite doesn't populate it from .env.
	Object.assign(process.env, loadEnv(mode, process.cwd(), ''));

	return {
		plugins: [
			tailwindcss(),
			sveltekit({
				compilerOptions: {
					// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
					runes: ({ filename }) =>
						filename.split(/[/\\]/).includes('node_modules') ? undefined : true
				},
				adapter: adapter()
			}),
			terminalWebSocket()
		]
	};
});
