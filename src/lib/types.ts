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

export type TempSensor = {
	label: string;
	/** null when unreadable, or the disk is spun down */
	celsius: number | null;
	/** Bar scale: the sensor's critical / max operating temperature, or a typical value */
	limitC: number;
	/** Disks: skipped because reading would spin it up */
	standby?: boolean;
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
	temperatures: {
		cpu: TempSensor | null;
		gpus: TempSensor[];
		/** physical disks, up to 30s old; null when smartctl can't run via sudo */
		disks: TempSensor[] | null;
	};
	sampledAt: string;
};

export type LogSources = {
	units: string[];
	/** null when the SSH user can't run docker */
	containers: string[] | null;
};

export type LogsResponse = { output: string; notice: string | null };
