import { execScript, splitSections } from './ssh';
import type { Container, Gpu, Stats, TempSensor } from '../types';

const SAMPLE_SECONDS = 0.5;

// One round trip; CPU, network and GPU idle time are sampled twice to compute rates.
// Reads /proc and sysfs directly where possible so it works on minimal installs.
const SCRIPT = `
export LC_ALL=C
first() { cat "$@" 2>/dev/null | head -n1; }
# DRM cards only (card0, card1), not connectors like card0-HDMI-A-1
cards() { for c in /sys/class/drm/card[0-9]*; do case "\${c##*/}" in *-*) ;; *) [ -e "$c" ] && echo "$c" ;; esac; done; }
# Intel: time spent in the RC6 sleep state (i915) or idle (xe); busy = 1 - idle/elapsed
gpu_idle() {
	date +%s%3N
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
	printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' "\${c##*/}" "$(cat "$d/vendor")" \\
		"$(first "$c/gt_act_freq_mhz" "$d/tile0/gt0/freq0/act_freq")" \\
		"$(first "$c/gt_RP0_freq_mhz" "$d/tile0/gt0/freq0/rp0_freq")" \\
		"$(first "$d/gpu_busy_percent")" \\
		"$(first "$d/mem_info_vram_used")" "$(first "$d/mem_info_vram_total")" \\
		"$(first "$d"/hwmon/hwmon*/temp1_input)" "$(first "$d"/hwmon/hwmon*/temp1_crit)" \\
		"$(lspci -mm -s "$(basename "$(readlink -f "$d")")" 2>/dev/null | head -n1)"
done
echo '@nvidia'
command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi --query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu --format=csv,noheader,nounits
echo '@cputemp'
for h in /sys/class/hwmon/hwmon*; do
	case "$(first "$h/name")" in coretemp|k10temp|zenpower) ;; *) continue ;; esac
	for t in "$h"/temp*_input; do
		[ -r "$t" ] || continue
		p="\${t%_input}"
		printf '%s\\t%s\\t%s\\n' "$(first "\${p}_label")" "$(first "$t")" "$(first "\${p}_crit")"
	done
done
echo '@mem'; cat /proc/meminfo
echo '@load'; cat /proc/loadavg
echo '@uptime'; cat /proc/uptime
echo '@cores'; nproc
echo '@host'; cat /proc/sys/kernel/hostname /proc/sys/kernel/osrelease
echo '@disk'; df -P -B1 -x tmpfs -x devtmpfs -x overlay -x squashfs -x efivarfs 2>/dev/null
echo '@docker'; docker ps -a --format '{{json .}}' 2>/dev/null || echo '!unavailable'
`;

// Physical disks only (sd*, nvme*): RAID members show up individually, md/zram/eMMC don't.
// The smartctl commands must match the sudoers rule exactly (see README).
// -n standby: a spun-down SATA disk is skipped instead of woken up.
const DISK_SCRIPT = `
export LC_ALL=C
echo '@lsblk'; lsblk -J -d -o NAME,TYPE,ROTA,MODEL
for d in $(lsblk -dn -o NAME,TYPE | awk '$2 == "disk" { print $1 }'); do
	echo "@smart $d"
	case "$d" in
		sd*) sudo -n /usr/sbin/smartctl --json=c -n standby -A -l scttempsts "/dev/$d" ;;
		nvme*) sudo -n /usr/sbin/smartctl --json=c -i -A "/dev/$d" ;;
	esac
	echo # compact JSON has no trailing newline
done
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

/** Bar scale for a temperature: the reported limit when it's sane, otherwise a typical value. */
const limitC = (reported: number | null | undefined, fallback: number): number =>
  reported != null && reported > 0 && reported <= 150 ? reported : fallback;

function cpuTemperature(lines: string[] = []): TempSensor | null {
  const sensors = lines.flatMap((line) => {
    const [label = '', input, crit] = line.split('\t');
    const milliC = num(input);
    return milliC === null ? [] : [{ label, celsius: milliC / 1000, crit: num(crit) }];
  });
  // Package (Intel) or die (AMD) sensor when there is one, otherwise the hottest core.
  const preferred = sensors.filter((s) => /^(Package id|Tdie)/.test(s.label));
  const tctl = sensors.filter((s) => s.label === 'Tctl');
  const candidates = preferred.length ? preferred : tctl.length ? tctl : sensors;
  if (!candidates.length) return null;
  const hottest = candidates.reduce((a, b) => (b.celsius > a.celsius ? b : a));
  return {
    label: 'CPU',
    celsius: hottest.celsius,
    limitC: limitC(hottest.crit !== null ? hottest.crit / 1000 : null, 100),
  };
}

function gpus(s: Map<string, string[]>): { gpus: Gpu[]; temperatures: TempSensor[] } {
  const before = idleSample(s.get('gpu1'));
  const after = idleSample(s.get('gpu2'));
  const elapsedMs = before.at !== null && after.at !== null ? after.at - before.at : 0;

  const result: Gpu[] = [];
  const temperatures: TempSensor[] = [];
  for (const line of s.get('gpuinfo') ?? []) {
    const [card, vendor, act, max, busy, vramUsed, vramTotal, temp, tempCrit, lspci] =
      line.split('\t');
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
    const critMilliC = num(tempCrit);
    const name = gpuName(vendor, lspci);
    if (milliC !== null) {
      temperatures.push({
        label: name,
        celsius: milliC / 1000,
        limitC: limitC(critMilliC !== null ? critMilliC / 1000 : null, 100),
      });
    }
    result.push({
      name,
      busyPercent,
      freqMhz: num(act),
      maxFreqMhz: num(max),
      vram: used !== null && total ? { used, total } : null,
      temperatureC: milliC !== null ? milliC / 1000 : null,
    });
  }

  for (const line of s.get('nvidia') ?? []) {
    const fields = line.split(',').map((f) => f.trim());
    const [util, memUsed, memTotal, temp] = fields.slice(-4).map(num);
    const name = fields.slice(0, -4).join(', ');
    if (temp !== null) temperatures.push({ label: name, celsius: temp, limitC: 100 });
    result.push({
      name,
      busyPercent: util,
      freqMhz: null,
      maxFreqMhz: null,
      vram:
        memUsed !== null && memTotal
          ? { used: memUsed * 1024 ** 2, total: memTotal * 1024 ** 2 }
          : null,
      temperatureC: temp,
    });
  }
  return { gpus: result, temperatures };
}

type LsblkDevice = {
  name: string;
  type: string;
  rota?: boolean | string | null;
  model?: string | null;
};
type SmartJson = {
  temperature?: { current?: number; op_limit_max?: number; critical_limit_max?: number };
  power_mode?: { name?: string };
};

/** null when smartctl couldn't run for any disk (no sudoers rule, or smartmontools missing). */
function diskTemperatures(s: Map<string, string[]>): TempSensor[] | null {
  let devices: LsblkDevice[] = [];
  try {
    devices =
      (JSON.parse((s.get('lsblk') ?? []).join('\n')) as { blockdevices?: LsblkDevice[] })
        .blockdevices ?? [];
  } catch {
    return [];
  }

  const result: TempSensor[] = [];
  let anyOutput = false;
  for (const d of devices) {
    if (d.type !== 'disk' || !/^(sd|nvme)/.test(d.name)) continue;
    const model = d.model?.trim();
    const label = model ? `${model} (${d.name})` : d.name;
    // util-linux >= 2.38 emits a boolean, older versions "1"/"0"
    const fallback = d.rota === true || d.rota === '1' ? 60 : 70;

    let smart: SmartJson | undefined;
    try {
      const line = s.get(`smart ${d.name}`)?.find((l) => l.startsWith('{'));
      smart = line ? (JSON.parse(line) as SmartJson) : undefined;
    } catch {
      smart = undefined;
    }
    if (smart) anyOutput = true;

    const t = smart?.temperature;
    const celsius = t?.current ?? null;
    result.push({
      label,
      celsius,
      limitC: limitC(t?.critical_limit_max ?? t?.op_limit_max, fallback),
      standby: celsius === null && /^(STANDBY|SLEEP)/.test(smart?.power_mode?.name ?? ''),
    });
  }
  return anyOutput || result.length === 0 ? result : null;
}

async function sampleDisks(): Promise<TempSensor[] | null> {
  const { stdout, stderr } = await execScript(DISK_SCRIPT, { timeoutMs: 30_000 });
  const result = diskTemperatures(splitSections(stdout));
  // Usually sudo ("a password is required") or a missing smartctl; visible in `docker compose logs server`
  if (result === null && stderr.trim()) console.error('[stats] disk temperatures:', stderr.trim());
  return result;
}

// Disk temps change slowly and each smartctl call is a SMART command to the drive, so they're
// refreshed in the background at most every 30s instead of on every stats poll.
const DISK_MAX_AGE_MS = 30_000;
let diskCache: { at: number; value: TempSensor[] | null } | undefined;
let diskInflight: Promise<TempSensor[] | null> | undefined;

function refreshDisks(): Promise<TempSensor[] | null> {
  diskInflight ??= sampleDisks()
    .catch((err) => {
      console.error('[stats] disk temperatures', err);
      return diskCache?.value ?? [];
    })
    .then((value) => {
      diskCache = { at: Date.now(), value };
      return value;
    })
    .finally(() => (diskInflight = undefined));
  return diskInflight;
}

function diskTemps(): Promise<TempSensor[] | null> {
  if (!diskCache) return refreshDisks(); // first request waits; later ones never do
  if (Date.now() - diskCache.at > DISK_MAX_AGE_MS) void refreshDisks();
  return Promise.resolve(diskCache.value);
}

async function sample(): Promise<Stats> {
  const [{ stdout }, diskSensors] = await Promise.all([
    execScript(SCRIPT, { timeoutMs: 15_000 }),
    diskTemps(),
  ]);
  const s = splitSections(stdout);
  const gpu = gpus(s);

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
    gpus: gpu.gpus,
    memory: { total: mem.MemTotal ?? 0, used: (mem.MemTotal ?? 0) - (mem.MemAvailable ?? 0) },
    swap: { total: mem.SwapTotal ?? 0, used: (mem.SwapTotal ?? 0) - (mem.SwapFree ?? 0) },
    disks: disks(s.get('disk')),
    network: {
      rxBytesPerSec: Math.max(0, net2.rx - net1.rx) / SAMPLE_SECONDS,
      txBytesPerSec: Math.max(0, net2.tx - net1.tx) / SAMPLE_SECONDS,
    },
    containers: containers(s.get('docker')),
    temperatures: {
      cpu: cpuTemperature(s.get('cputemp')),
      gpus: gpu.temperatures,
      disks: diskSensors,
    },
    sampledAt: new Date().toISOString(),
  };
}

// Coalesce concurrent requests (multiple tabs) and cache briefly: each sample holds an SSH channel for ~0.5s.
const MAX_AGE_MS = 400;
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
