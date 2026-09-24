const UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];

export function bytes(n: number): string {
	let i = 0;
	while (n >= 1024 && i < UNITS.length - 1) {
		n /= 1024;
		i++;
	}
	return `${n.toFixed(i === 0 || n >= 100 ? 0 : 1)} ${UNITS[i]}`;
}

export function duration(seconds: number): string {
	const d = Math.floor(seconds / 86_400);
	const h = Math.floor((seconds % 86_400) / 3_600);
	const m = Math.floor((seconds % 3_600) / 60);
	if (d > 0) return `${d}d ${h}h`;
	if (h > 0) return `${h}h ${m}m`;
	return `${m}m`;
}

export function percent(used: number, total: number): number {
	return total > 0 ? (used / total) * 100 : 0;
}
