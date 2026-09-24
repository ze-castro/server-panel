import { json } from '@sveltejs/kit';
import { parseLogQuery, readLogs } from '$lib/server/logs';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ url }) => {
	const query = parseLogQuery(url.searchParams);
	if (typeof query === 'string') return json({ message: query }, { status: 400 });
	try {
		return json(await readLogs(query), { headers: { 'cache-control': 'no-store' } });
	} catch (err) {
		return json({ message: err instanceof Error ? err.message : String(err) }, { status: 502 });
	}
};
