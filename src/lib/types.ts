export type Usage = { used: number; total: number };

export type Container = { name: string; image: string; state: string; status: string };

export type Gpu = {
	name: string;
	/** null when the driver exposes no utilization (e.g. Intel without RC6 stats) */
	busyPercent: number | null;
	freqMhz: number | null;
	maxFreqMhz: number | null;
	/** dedicated memory; null for integrated GPUs */
	vram: Usage | null;
	temperatureC: number | null;
};

export type Stats = {
	hostname: string;
	kernel: string;
	uptimeSeconds: number;
	cores: number;
	load: [number, number, number];
	cpuPercent: number;
	gpus: Gpu[];
	memory: Usage;
	swap: Usage;
	disks: (Usage & { mount: string })[];
	network: { rxBytesPerSec: number; txBytesPerSec: number };
	/** null when the SSH user can't run `docker ps` */
	containers: Container[] | null;
	sampledAt: string;
};

export type LogSources = {
	units: string[];
	/** null when the SSH user can't run docker */
	containers: string[] | null;
};

export type LogsResponse = { output: string; notice: string | null };
