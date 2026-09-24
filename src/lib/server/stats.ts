import { execScript, splitSections } from './ssh';
import type { Container, Gpu, Stats } from '../types';

const SAMPLE_SECONDS = 1;

// One round trip; CPU, network and GPU idle time are sampled twice to compute rates.
// Reads /proc and sysfs directly where possible so it works on minimal installs.
const SCRIPT = `
export LC_ALL=C
first() { cat "$@" 2>/dev/null | head -n1; }
# DRM cards only (card0, card1), not connectors like card0-HDMI-A-1
cards() { for c in /sys/class/drm/card[0-9]*; do case "\${c##*/}" in *-*) ;; *) [ -e "$c" ] && echo "$c" ;; esac; done; }
# Intel: time spent in the RC6 sleep state (i915) or idle (xe); busy = 1 - idle/elapsed
gpu_idle() {
	cut -d' ' -f1 /proc/uptime
	for c in $(cards); do
		printf '%s\\t%s\\n' "\${c##*/}" "$(first "$c/power/rc6_residency_ms" "$c/device/tile0/gt0/gtidle/idle_residency_ms")"
	done
}
echo '@cpu1'; head -n1 /proc/stat
echo '@net1'; cat /proc/net/dev
echo '@gpu1'; gpu_idle
sleep ${SAMPLE_SECONDS}
echo '@cpu2'; head -n1 /proc/stat
echo '@net2'; cat /proc/net/dev
echo '@gpu2'; gpu_idle
echo '@gpuinfo'
for c in $(cards); do
	d="$c/device"
	[ -r "$d/vendor" ] || continue
	printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' "\${c##*/}" "$(cat "$d/vendor")" \\
		"$(first "$c/gt_act_freq_mhz" "$d/tile0/gt0/freq0/act_freq")" \\
		"$(first "$c/gt_RP0_freq_mhz" "$d/tile0/gt0/freq0/rp0_freq")" \\
		"$(first "$d/gpu_busy_percent")" \\
		"$(first "$d/mem_info_vram_used")" "$(first "$d/mem_info_vram_total")" \\
		"$(first "$d"/hwmon/hwmon*/temp1_input)" \\
		"$(lspci -mm -s "$(basename "$(readlink -f "$d")")" 2>/dev/null | head -n1)"
done
echo '@nvidia'
command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi --query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu --format=csv,noheader,nounits
echo '@mem'; cat /proc/meminfo
echo '@load'; cat /proc/loadavg
echo '@uptime'; cat /proc/uptime
echo '@cores'; nproc
echo '@host'; cat /proc/sys/kernel/hostname /proc/sys/kernel/osrelease
echo '@disk'; df -P -B1 -x tmpfs -x devtmpfs -x overlay -x squashfs -x efivarfs 2>/dev/null
echo '@docker'; docker ps -a --format '{{json .}}' 2>/dev/null || echo '!unavailable'
`;

function cpuTimes(line = ''): { idle: number; total: number } {
	const n = line.trim().split(/\s+/).slice(1, 9).map(Number); // user..steal; guest is already in user
	return { idle: (n[3] ?? 0) + (n[4] ?? 0), total: n.reduce((a, b) => a + b, 0) };
}

const IGNORED_IFACE = /^(lo|docker\d*|br-|veth)/;

function netBytes(lines: string[] = []): { rx: number; tx: number } {
	let rx = 0;
	let tx = 0;
	for (const line of lines) {
		const [name, rest] = line.split(':');
		if (!rest || IGNORED_IFACE.test(name.trim())) continue;
		const f = rest.trim().split(/\s+/).map(Number);
		rx += f[0] ?? 0;
		tx += f[8] ?? 0;
	}
	return { rx, tx };
}

function meminfo(lines: string[] = []): Record<string, number> {
	const out: Record<string, number> = {};
	for (const line of lines) {
		const m = /^(\w+):\s+(\d+)/.exec(line);
		if (m) out[m[1]] = Number(m[2]) * 1024;
	}
	return out;
}

function disks(lines: string[] = []): Stats['disks'] {
	const seen = new Set<string>();
	const result: Stats['disks'] = [];
	for (const line of lines.slice(1)) {
		const f = line.trim().split(/\s+/);
		if (f.length < 6 || seen.has(f[0])) continue; // skip bind mounts of the same device
		seen.add(f[0]);
		result.push({ mount: f.slice(5).join(' '), total: Number(f[1]), used: Number(f[2]) });
	}
	return result;
}

function containers(lines: string[] = []): Container[] | null {
	if (lines[0] === '!unavailable') return null;
	return lines.flatMap((line) => {
		try {
			const c = JSON.parse(line) as Record<string, string>;
			return [{ name: c.Names, image: c.Image, state: c.State, status: c.Status }];
		} catch {
			return [];
		}
	});
}

const VENDORS: Record<string, string> = { '0x8086': 'Intel', '0x1002': 'AMD', '0x10de': 'NVIDIA' };

const num = (value: string | undefined): number | null =>
	value !== undefined && value.trim() !== '' && !Number.isNaN(Number(value)) ? Number(value) : null;

/** "00:02.0 "VGA compatible controller" "Intel Corporation" "Alder Lake-N [UHD Graphics]" ..." → "Intel UHD Graphics" */
function gpuName(vendorId: string, lspci: string | undefined): string {
	const vendor = VENDORS[vendorId] ?? 'GPU';
	const device = [...(lspci ?? '').matchAll(/"([^"]*)"/g)][2]?.[1];
	if (!device) return vendor === 'GPU' ? 'GPU' : `${vendor} GPU`;
	return `${vendor} ${/\[([^\]]+)\]/.exec(device)?.[1] ?? device}`;
}

function idleSample(lines: string[] = []): { at: number | null; idle: Map<string, number | null> } {
	const idle = new Map<string, number | null>();
	for (const line of lines.slice(1)) {
		const [card, value] = line.split('\t');
		idle.set(card, num(value));
	}
	return { at: num(lines[0]), idle };
}

function gpus(s: Map<string, string[]>): Gpu[] {
	const before = idleSample(s.get('gpu1'));
	const after = idleSample(s.get('gpu2'));
	const elapsedMs = before.at !== null && after.at !== null ? (after.at - before.at) * 1000 : 0;

	const result: Gpu[] = [];
	for (const line of s.get('gpuinfo') ?? []) {
		const [card, vendor, act, max, busy, vramUsed, vramTotal, temp, lspci] = line.split('\t');
		if (vendor === '0x10de') continue; // NVIDIA comes from nvidia-smi below

		let busyPercent = num(busy); // AMD reports this directly
		const idle1 = before.idle.get(card);
		const idle2 = after.idle.get(card);
		if (busyPercent === null && idle1 != null && idle2 != null && elapsedMs > 0) {
			busyPercent = Math.min(100, Math.max(0, (1 - (idle2 - idle1) / elapsedMs) * 100));
		}

		const used = num(vramUsed);
		const total = num(vramTotal);
		const milliC = num(temp);
		result.push({
			name: gpuName(vendor, lspci),
			busyPercent,
			freqMhz: num(act),
			maxFreqMhz: num(max),
			vram: used !== null && total ? { used, total } : null,
			temperatureC: milliC !== null ? milliC / 1000 : null
		});
	}

	for (const line of s.get('nvidia') ?? []) {
		const fields = line.split(',').map((f) => f.trim());
		const [util, memUsed, memTotal, temp] = fields.slice(-4).map(num);
		result.push({
			name: fields.slice(0, -4).join(', '),
			busyPercent: util,
			freqMhz: null,
			maxFreqMhz: null,
			vram:
				memUsed !== null && memTotal
					? { used: memUsed * 1024 ** 2, total: memTotal * 1024 ** 2 }
					: null,
			temperatureC: temp
		});
	}
	return result;
}

async function sample(): Promise<Stats> {
	const { stdout } = await execScript(SCRIPT, { timeoutMs: 15_000 });
	const s = splitSections(stdout);

	const cpu1 = cpuTimes(s.get('cpu1')?.[0]);
	const cpu2 = cpuTimes(s.get('cpu2')?.[0]);
	const dTotal = cpu2.total - cpu1.total;
	const cpuPercent = dTotal > 0 ? (1 - (cpu2.idle - cpu1.idle) / dTotal) * 100 : 0;

	const net1 = netBytes(s.get('net1'));
	const net2 = netBytes(s.get('net2'));

	const mem = meminfo(s.get('mem'));
	const load = (s.get('load')?.[0] ?? '').split(/\s+/).slice(0, 3).map(Number);
	const [hostname = 'unknown', kernel = ''] = s.get('host') ?? [];

	return {
		hostname,
		kernel,
		uptimeSeconds: Number((s.get('uptime')?.[0] ?? '0').split(/\s+/)[0]),
		cores: Number(s.get('cores')?.[0] ?? 1),
		load: [load[0] ?? 0, load[1] ?? 0, load[2] ?? 0],
		cpuPercent,
		gpus: gpus(s),
		memory: { total: mem.MemTotal ?? 0, used: (mem.MemTotal ?? 0) - (mem.MemAvailable ?? 0) },
		swap: { total: mem.SwapTotal ?? 0, used: (mem.SwapTotal ?? 0) - (mem.SwapFree ?? 0) },
		disks: disks(s.get('disk')),
		network: {
			rxBytesPerSec: Math.max(0, net2.rx - net1.rx) / SAMPLE_SECONDS,
			txBytesPerSec: Math.max(0, net2.tx - net1.tx) / SAMPLE_SECONDS
		},
		containers: containers(s.get('docker')),
		sampledAt: new Date().toISOString()
	};
}

// Coalesce concurrent requests (multiple tabs) and cache briefly: each sample holds an SSH channel for ~1s.
const MAX_AGE_MS = 2_000;
let cached: { at: number; value: Stats } | undefined;
let inflight: Promise<Stats> | undefined;

export function getStats(): Promise<Stats> {
	if (cached && Date.now() - cached.at < MAX_AGE_MS) return Promise.resolve(cached.value);
	inflight ??= sample()
		.then((value) => {
			cached = { at: Date.now(), value };
			return value;
		})
		.finally(() => (inflight = undefined));
	return inflight;
}
