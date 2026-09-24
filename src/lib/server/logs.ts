import { execScript, splitSections } from './ssh';
import type { LogSources, LogsResponse } from '../types';

export const LINE_OPTIONS = [200, 500, 2000] as const;

// These values end up in a shell command, so they're validated against strict patterns and quoted.
const PRIORITIES = new Set(['emerg', 'alert', 'crit', 'err', 'warning', 'notice', 'info', 'debug']);
const UNIT_NAME = /^[A-Za-z0-9@._:\\-]+$/; // backslash appears in escaped units (e.g. \x2d)
const CONTAINER_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

export type LogQuery =
	| { source: 'journal'; lines: number; unit: string | null; priority: string | null }
	| { source: 'docker'; lines: number; container: string };

/** Returns the parsed query, or an error message. */
export function parseLogQuery(params: URLSearchParams): LogQuery | string {
	const lines = Number(params.get('lines') ?? 500);
	if (!(LINE_OPTIONS as readonly number[]).includes(lines)) return 'Invalid line count.';

	const source = params.get('source');
	if (source === 'journal') {
		const unit = params.get('unit');
		const priority = params.get('priority');
		if (unit !== null && !UNIT_NAME.test(unit)) return 'Invalid unit name.';
		if (priority !== null && !PRIORITIES.has(priority)) return 'Invalid priority.';
		return { source, lines, unit, priority };
	}
	if (source === 'docker') {
		const container = params.get('container') ?? '';
		if (!CONTAINER_NAME.test(container)) return 'Invalid container name.';
		return { source, lines, container };
	}
	return 'Unknown log source.';
}

export async function readLogs(query: LogQuery): Promise<LogsResponse> {
	const command =
		query.source === 'journal'
			? [
					'journalctl --no-pager -o short-iso',
					`-n ${query.lines}`,
					query.unit && `-u ${shellQuote(query.unit)}`,
					query.priority && `-p ${query.priority}`
				]
					.filter(Boolean)
					.join(' ')
			: `docker logs --tail ${query.lines} --timestamps ${shellQuote(query.container)} 2>&1`;

	const { stdout, stderr, code } = await execScript(command, { timeoutMs: 15_000 });
	if (code !== 0) throw new Error(stderr.trim() || stdout.trim() || 'Log command failed.');
	// journalctl prints hints (e.g. missing journal permissions) on stderr with exit code 0.
	return { output: stdout, notice: stderr.trim() || null };
}

const SOURCES_SCRIPT = `
echo '@units'; systemctl list-units --type=service --all --no-legend --plain --no-pager 2>/dev/null | awk '{print $1}'
echo '@containers'; docker ps -a --format '{{.Names}}' 2>/dev/null || echo '!unavailable'
`;

export async function listLogSources(): Promise<LogSources> {
	const s = splitSections((await execScript(SOURCES_SCRIPT)).stdout);
	const containers = s.get('containers') ?? [];
	return {
		units: (s.get('units') ?? []).sort((a, b) => a.localeCompare(b)),
		containers:
			containers[0] === '!unavailable' ? null : containers.sort((a, b) => a.localeCompare(b))
	};
}
