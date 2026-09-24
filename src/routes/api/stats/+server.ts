import { json } from '@sveltejs/kit';
import { getStats } from '$lib/server/stats';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async () => {
	try {
		return json(await getStats(), { headers: { 'cache-control': 'no-store' } });
	} catch (err) {
		console.error('[stats]', err);
		return json({ message: 'Could not reach the server over SSH.' }, { status: 502 });
	}
};
