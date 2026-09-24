<script lang="ts">
  import { tick } from 'svelte';
  import RefreshCwIcon from '@lucide/svelte/icons/refresh-cw';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import { Label } from '$lib/components/ui/label/index.js';
  import * as Select from '$lib/components/ui/select/index.js';
  import { Switch } from '$lib/components/ui/switch/index.js';
  import type { LogSources, LogsResponse } from '$lib/types';

  let { active }: { active: boolean } = $props();

  const ALL_UNITS = '__all__';
  const FOLLOW_MS = 3_000;
  const SOURCE_LABELS: Record<string, string> = { journal: 'Systemd journal', docker: 'Docker' };
  const PRIORITY_LABELS: Record<string, string> = {
    all: 'All levels',
    warning: 'Warnings and up',
    err: 'Errors and up',
  };
  const LINE_OPTIONS = ['200', '500', '2000'];

  let sources = $state<LogSources | null>(null);
  let source = $state('journal');
  let unit = $state(ALL_UNITS);
  let priority = $state('all');
  let container = $state('');
  let lines = $state('500');
  let filter = $state('');
  let follow = $state(false);

  let output = $state('');
  let notice = $state<string | null>(null);
  let error = $state<string | null>(null);
  let loading = $state(false);
  let viewport: HTMLPreElement;

  const query = $derived.by(() => {
    const params = new URLSearchParams({ source, lines });
    if (source === 'journal') {
      if (unit !== ALL_UNITS) params.set('unit', unit);
      if (priority !== 'all') params.set('priority', priority);
    } else {
      if (!container) return null;
      params.set('container', container);
    }
    return params.toString();
  });

  const shown = $derived.by(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return output;
    return output
      .split('\n')
      .filter((line) => line.toLowerCase().includes(needle))
      .join('\n');
  });

  // Load units and containers the first time the tab is opened.
  let sourcesRequested = false;
  $effect(() => {
    if (!active || sourcesRequested) return;
    sourcesRequested = true;
    fetch('/api/logs/sources')
      .then((res) => (res.ok ? (res.json() as Promise<LogSources>) : Promise.reject()))
      .then((result) => {
        sources = result;
        container ||= result.containers?.[0] ?? '';
      })
      .catch(() => {
        sourcesRequested = false; // retry next time the tab opens
        error = 'Could not load units and containers.';
      });
  });

  // Responses can arrive out of order when the selection changes quickly; only the latest one counts.
  let latestRequest = 0;

  async function load(scroll: 'always' | 'if-at-bottom') {
    if (!query) {
      output = '';
      notice = null;
      return;
    }
    const id = ++latestRequest;
    const atBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 40;
    loading = true;
    try {
      const res = await fetch(`/api/logs?${query}`);
      const body = await res.json();
      if (id !== latestRequest) return;
      if (!res.ok) {
        error = body.message ?? `Request failed (${res.status}).`;
        return;
      }
      ({ output, notice } = body as LogsResponse);
      error = null;
      if (scroll === 'always' || atBottom) {
        await tick();
        viewport.scrollTop = viewport.scrollHeight;
      }
    } catch {
      if (id === latestRequest) error = 'Could not load logs.';
    } finally {
      if (id === latestRequest) loading = false;
    }
  }

  // Reload whenever the selection changes (reads `query` synchronously inside load).
  $effect(() => {
    if (active) load('always');
  });

  $effect(() => {
    if (!active || !follow || !query) return;
    const timer = setInterval(() => load('if-at-bottom'), FOLLOW_MS);
    return () => clearInterval(timer);
  });
</script>

<div class="flex h-full min-h-0 flex-col">
  <div class="flex flex-wrap items-center gap-2 border-b border-white/10 px-3 py-2">
    <Select.Root type="single" bind:value={source}>
      <Select.Trigger class="w-40">{SOURCE_LABELS[source]}</Select.Trigger>
      <Select.Content>
        {#each Object.entries(SOURCE_LABELS) as [value, label] (value)}
          <Select.Item {value} {label}>{label}</Select.Item>
        {/each}
      </Select.Content>
    </Select.Root>

    {#if source === 'journal'}
      <Select.Root type="single" bind:value={unit}>
        <Select.Trigger class="w-56">
          <span class="truncate">{unit === ALL_UNITS ? 'All units' : unit}</span>
        </Select.Trigger>
        <Select.Content class="max-h-80">
          <Select.Item value={ALL_UNITS} label="All units">All units</Select.Item>
          {#each sources?.units ?? [] as name (name)}
            <Select.Item value={name} label={name}>{name}</Select.Item>
          {/each}
        </Select.Content>
      </Select.Root>
      <Select.Root type="single" bind:value={priority}>
        <Select.Trigger class="w-40">{PRIORITY_LABELS[priority]}</Select.Trigger>
        <Select.Content>
          {#each Object.entries(PRIORITY_LABELS) as [value, label] (value)}
            <Select.Item {value} {label}>{label}</Select.Item>
          {/each}
        </Select.Content>
      </Select.Root>
    {:else if sources?.containers}
      <Select.Root type="single" bind:value={container}>
        <Select.Trigger class="w-56">
          <span class="truncate">{container || 'Choose a container'}</span>
        </Select.Trigger>
        <Select.Content class="max-h-80">
          {#each sources.containers as name (name)}
            <Select.Item value={name} label={name}>{name}</Select.Item>
          {/each}
        </Select.Content>
      </Select.Root>
    {/if}

    <Select.Root type="single" bind:value={lines}>
      <Select.Trigger class="w-32">Last {lines}</Select.Trigger>
      <Select.Content>
        {#each LINE_OPTIONS as value (value)}
          <Select.Item {value} label="Last {value}">Last {value} lines</Select.Item>
        {/each}
      </Select.Content>
    </Select.Root>

    <Input type="search" placeholder="Filter lines" bind:value={filter} class="w-44" />

    <div class="ml-auto flex items-center gap-3">
      <div class="flex items-center gap-2">
        <Switch id="logs-follow" bind:checked={follow} />
        <Label for="logs-follow">Follow</Label>
      </div>
      <Button
        size="icon"
        variant="ghost"
        aria-label="Refresh logs"
        disabled={loading || !query}
        onclick={() => load('always')}
      >
        <RefreshCwIcon class={loading ? 'animate-spin' : ''} />
      </Button>
    </div>
  </div>

  {#if source === 'docker' && sources && !sources.containers}
    <p class="px-4 py-3 text-sm text-amber-400">
      Add the SSH user to the docker group to read container logs.
    </p>
  {/if}
  {#if error}
    <p class="text-destructive px-4 py-3 text-sm" role="status">{error}</p>
  {/if}
  {#if notice}
    <p class="px-4 py-2 text-xs text-zinc-500">{notice}</p>
  {/if}

  <pre
    bind:this={viewport}
    class="min-h-0 flex-1 overflow-auto overscroll-contain p-4 font-mono text-xs leading-relaxed whitespace-pre text-zinc-300">{shown ||
      (loading ? 'Loading…' : filter ? 'No lines match the filter.' : '')}</pre>
</div>
