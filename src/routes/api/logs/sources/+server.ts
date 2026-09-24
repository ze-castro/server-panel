import { json } from '@sveltejs/kit';
import { listLogSources } from '$lib/server/logs';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async () => {
	try {
		return json(await listLogSources(), { headers: { 'cache-control': 'no-store' } });
	} catch (err) {
		console.error('[logs]', err);
		return json({ message: 'Could not reach the server over SSH.' }, { status: 502 });
	}
};
