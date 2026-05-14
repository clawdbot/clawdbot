import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import * as inspector from "node:inspector";
import { tmpdir } from "node:os";
import path from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import {
  ensureOpenClawModelsJson,
  resetModelsJsonReadyCacheForTest,
} from "../../src/agents/models-config.js";
import { resolveModelAsync } from "../../src/agents/pi-embedded-runner/model.js";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";

type Options = {
  agentCount: number;
  cpuProfDir?: string;
  cpuProfOutput?: string;
  json: boolean;
  keepTemp: boolean;
  lookupsPerRun: number;
  modelsPerProvider: number;
  output?: string;
  providers: number;
  runs: number;
  runtimeHooks: boolean;
  warmup: number;
};

type PhaseSample = {
  ensureMs: number;
  resolveMs: number;
  totalMs: number;
  wrote: boolean;
};

type RunSample = {
  cold: PhaseSample;
  eventLoopDelayMaxMs: number;
  eventLoopDelayMeanMs: number;
  index: number;
  rssMb: number;
  warm: PhaseSample;
};

type SummaryStats = {
  avg: number;
  max: number;
  min: number;
  p50: number;
  p95: number;
};

type Report = {
  scenario: string;
  options: Omit<Options, "json" | "keepTemp">;
  samples: RunSample[];
  summary: {
    coldEnsureMs: SummaryStats;
    coldResolveMs: SummaryStats;
    coldTotalMs: SummaryStats;
    warmEnsureMs: SummaryStats;
    warmResolveMs: SummaryStats;
    warmTotalMs: SummaryStats;
    eventLoopDelayMaxMs: SummaryStats;
    rssMb: SummaryStats;
  };
  tempRoot: string;
  cpuProfilePath?: string;
};

function parseFlagValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  if (index === -1) {
    return undefined;
  }
  return process.argv[index + 1];
}

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

function parsePositiveInt(flag: string, fallback: number): number {
  const raw = parseFlagValue(flag);
  if (!raw) {
    return fallback;
  }
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return value;
}

function parseNonNegativeInt(flag: string, fallback: number): number {
  const raw = parseFlagValue(flag);
  if (!raw) {
    return fallback;
  }
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${flag} must be a non-negative integer`);
  }
  return value;
}

function parseOptions(): Options {
  return {
    agentCount: parsePositiveInt("--agents", 8),
    cpuProfDir: parseFlagValue("--cpu-prof-dir"),
    cpuProfOutput: parseFlagValue("--cpu-prof-output"),
    json: hasFlag("--json"),
    keepTemp: hasFlag("--keep-temp"),
    lookupsPerRun: parsePositiveInt("--lookups", 32),
    modelsPerProvider: parsePositiveInt("--models-per-provider", 16),
    output: parseFlagValue("--output"),
    providers: parsePositiveInt("--providers", 48),
    runs: parsePositiveInt("--runs", 8),
    runtimeHooks: hasFlag("--runtime-hooks"),
    warmup: parseNonNegativeInt("--warmup", 1),
  };
}

function printUsage(): void {
  process.stdout.write(`OpenClaw issue #78851 model-resolution profiler

Usage:
  pnpm perf:issue-78851 -- [options]
  node --import tsx scripts/perf/issue-78851-model-resolution.ts [options]

Options:
  --providers <n>             Synthetic configured providers (default: 48)
  --models-per-provider <n>   Models per provider (default: 16)
  --agents <n>                Agent configs/fallback chains (default: 8)
  --lookups <n>               resolveModelAsync calls per phase (default: 32)
  --runs <n>                  Measured runs (default: 8)
  --warmup <n>                Warmup runs before measurement (default: 1)
  --cpu-prof-dir <dir>        Write a V8 .cpuprofile for the measured loop
  --cpu-prof-output <path>    Write the V8 .cpuprofile to this exact path
  --runtime-hooks             Include provider runtime hook resolution
  --output <path>             Write JSON report
  --json                      Print JSON report
  --keep-temp                 Keep generated temp state
  --help, -h                  Show this text
`);
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = values.toSorted((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p));
  return round(sorted[index] ?? 0);
}

function stats(values: number[]): SummaryStats {
  if (values.length === 0) {
    return { avg: 0, max: 0, min: 0, p50: 0, p95: 0 };
  }
  const total = values.reduce((sum, value) => sum + value, 0);
  return {
    avg: round(total / values.length),
    max: round(Math.max(...values)),
    min: round(Math.min(...values)),
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
  };
}

function modelRef(providerIndex: number, modelIndex: number): string {
  return `perf-${providerIndex}/perf-model-${modelIndex}`;
}

function buildConfig(options: Options, workspaceDir: string): OpenClawConfig {
  const providers: NonNullable<NonNullable<OpenClawConfig["models"]>["providers"]> = {};
  for (let providerIndex = 0; providerIndex < options.providers; providerIndex += 1) {
    providers[`perf-${providerIndex}`] = {
      api: providerIndex % 2 === 0 ? "openai-responses" : "openai-completions",
      apiKey: "perf-key",
      baseUrl: `http://127.0.0.1:${20_000 + providerIndex}/v1`,
      models: Array.from({ length: options.modelsPerProvider }, (_, modelIndex) => ({
        api: modelIndex % 2 === 0 ? "openai-responses" : "openai-completions",
        baseUrl: `http://127.0.0.1:${20_000 + providerIndex}/v1`,
        contextWindow: 128_000 + modelIndex,
        cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
        id: `perf-model-${modelIndex}`,
        input: modelIndex % 5 === 0 ? ["text", "image"] : ["text"],
        maxTokens: 8192,
        name: `Perf Model ${providerIndex}.${modelIndex}`,
        params: {
          cacheRetention: modelIndex % 3 === 0 ? "ephemeral" : undefined,
          syntheticRank: providerIndex * options.modelsPerProvider + modelIndex,
        },
        reasoning: modelIndex % 3 === 0,
      })),
      params: {
        syntheticProviderRank: providerIndex,
      },
    };
  }

  const fallbacks = Array.from({ length: Math.min(12, options.providers) }, (_, index) =>
    modelRef(index, index % options.modelsPerProvider),
  );

  return {
    browser: { enabled: false },
    agents: {
      defaults: {
        contextInjection: "never",
        model: {
          primary: modelRef(0, 0),
          fallbacks,
        },
        skipBootstrap: true,
        workspace: workspaceDir,
      },
      list: Array.from({ length: options.agentCount }, (_, index) => ({
        default: index === 0,
        id: `agent-${index}`,
        model: {
          primary: modelRef(index % options.providers, index % options.modelsPerProvider),
          fallbacks: fallbacks.toReversed(),
        },
        workspace: path.join(workspaceDir, `agent-${index}`),
      })),
    },
    gateway: {
      auth: { mode: "none" },
      bind: "loopback",
      controlUi: { enabled: false },
      mode: "local",
    },
    memory: {
      active: {
        allowedChatTypes: ["direct"],
        agents: ["main"],
        logging: false,
        maxSummaryChars: 220,
        persistTranscripts: false,
        promptStyle: "balanced",
        queryMode: "recent",
        timeoutMs: 15_000,
      },
    },
    models: {
      mode: "replace",
      providers,
    },
    plugins: {
      enabled: true,
      entries: {
        browser: { enabled: false },
      },
    },
  };
}

async function startCpuProfile(params: { dir?: string; output?: string }): Promise<{
  stop: () => Promise<string>;
}> {
  const fallbackDir = ".artifacts/perf/issue-78851/cpu";
  const cpuProfDir = params.dir ?? path.dirname(params.output ?? fallbackDir);
  await mkdir(cpuProfDir, { recursive: true });
  const session = new inspector.Session();
  session.connect();
  const post = <T>(method: string, params?: Record<string, unknown>) =>
    new Promise<T>((resolve, reject) => {
      session.post(method, params ?? {}, (error, result) => {
        if (error) {
          reject(error);
        } else {
          resolve(result as T);
        }
      });
    });
  await post("Profiler.enable");
  await post("Profiler.start");
  return {
    async stop() {
      const result = await post<{ profile: unknown }>("Profiler.stop");
      session.disconnect();
      const profilePath =
        params.output ??
        path.join(cpuProfDir, `issue-78851-${process.pid}-${Date.now()}.cpuprofile`);
      await mkdir(path.dirname(profilePath), { recursive: true });
      await writeFile(profilePath, JSON.stringify(result.profile));
      return profilePath;
    },
  };
}

async function measurePhase(params: {
  agentDir: string;
  config: OpenClawConfig;
  lookups: number;
  modelIndexOffset: number;
  providerCount: number;
  modelsPerProvider: number;
  workspaceDir: string;
  runtimeHooks: boolean;
}): Promise<PhaseSample> {
  const started = performance.now();
  const ensureStarted = performance.now();
  const ensureResult = await ensureOpenClawModelsJson(params.config, params.agentDir, {
    // Keep this harness deterministic by measuring configured-model scale.
    // Live provider catalog timing belongs in a separate Crabbox lane with secrets.
    providerDiscoveryProviderIds: [],
    providerDiscoveryTimeoutMs: 5_000,
    workspaceDir: params.workspaceDir,
  });
  const ensureMs = performance.now() - ensureStarted;
  const resolveStarted = performance.now();
  for (let lookupIndex = 0; lookupIndex < params.lookups; lookupIndex += 1) {
    const providerIndex = lookupIndex % params.providerCount;
    const modelIndex = (lookupIndex + params.modelIndexOffset) % params.modelsPerProvider;
    const resolved = await resolveModelAsync(
      `perf-${providerIndex}`,
      `perf-model-${modelIndex}`,
      params.agentDir,
      params.config,
      {
        skipProviderRuntimeHooks: !params.runtimeHooks,
        workspaceDir: params.workspaceDir,
      },
    );
    if (!resolved.model) {
      throw new Error(resolved.error ?? `failed to resolve ${modelRef(providerIndex, modelIndex)}`);
    }
  }
  const resolveMs = performance.now() - resolveStarted;
  return {
    ensureMs: round(ensureMs),
    resolveMs: round(resolveMs),
    totalMs: round(performance.now() - started),
    wrote: ensureResult.wrote,
  };
}

async function runOne(params: {
  config: OpenClawConfig;
  index: number;
  options: Options;
  tempRoot: string;
  workspaceDir: string;
}): Promise<RunSample> {
  const agentDir = path.join(params.tempRoot, `agent-state-${params.index}`);
  await mkdir(agentDir, { recursive: true });
  resetModelsJsonReadyCacheForTest();
  const histogram = monitorEventLoopDelay({ resolution: 10 });
  histogram.enable();
  const cold = await measurePhase({
    agentDir,
    config: params.config,
    lookups: params.options.lookupsPerRun,
    modelIndexOffset: params.index,
    modelsPerProvider: params.options.modelsPerProvider,
    providerCount: params.options.providers,
    workspaceDir: params.workspaceDir,
    runtimeHooks: params.options.runtimeHooks,
  });
  const warm = await measurePhase({
    agentDir,
    config: params.config,
    lookups: params.options.lookupsPerRun,
    modelIndexOffset: params.index + 1,
    modelsPerProvider: params.options.modelsPerProvider,
    providerCount: params.options.providers,
    workspaceDir: params.workspaceDir,
    runtimeHooks: params.options.runtimeHooks,
  });
  histogram.disable();
  return {
    cold,
    eventLoopDelayMaxMs: round(histogram.max / 1_000_000),
    eventLoopDelayMeanMs: round(histogram.mean / 1_000_000),
    index: params.index,
    rssMb: round(process.memoryUsage().rss / 1024 / 1024),
    warm,
  };
}

function summarize(samples: RunSample[]): Report["summary"] {
  return {
    coldEnsureMs: stats(samples.map((sample) => sample.cold.ensureMs)),
    coldResolveMs: stats(samples.map((sample) => sample.cold.resolveMs)),
    coldTotalMs: stats(samples.map((sample) => sample.cold.totalMs)),
    eventLoopDelayMaxMs: stats(samples.map((sample) => sample.eventLoopDelayMaxMs)),
    rssMb: stats(samples.map((sample) => sample.rssMb)),
    warmEnsureMs: stats(samples.map((sample) => sample.warm.ensureMs)),
    warmResolveMs: stats(samples.map((sample) => sample.warm.resolveMs)),
    warmTotalMs: stats(samples.map((sample) => sample.warm.totalMs)),
  };
}

function printHuman(report: Report, cpuProfilePath?: string): void {
  const lines = [
    `scenario: ${report.scenario}`,
    `providers: ${report.options.providers}`,
    `modelsPerProvider: ${report.options.modelsPerProvider}`,
    `agents: ${report.options.agentCount}`,
    `lookups: ${report.options.lookupsPerRun}`,
    `runs: ${report.options.runs}`,
    `runtimeHooks: ${report.options.runtimeHooks}`,
    `coldTotalMs: avg=${report.summary.coldTotalMs.avg} p50=${report.summary.coldTotalMs.p50} p95=${report.summary.coldTotalMs.p95} max=${report.summary.coldTotalMs.max}`,
    `coldEnsureMs: avg=${report.summary.coldEnsureMs.avg} p50=${report.summary.coldEnsureMs.p50} p95=${report.summary.coldEnsureMs.p95} max=${report.summary.coldEnsureMs.max}`,
    `coldResolveMs: avg=${report.summary.coldResolveMs.avg} p50=${report.summary.coldResolveMs.p50} p95=${report.summary.coldResolveMs.p95} max=${report.summary.coldResolveMs.max}`,
    `warmTotalMs: avg=${report.summary.warmTotalMs.avg} p50=${report.summary.warmTotalMs.p50} p95=${report.summary.warmTotalMs.p95} max=${report.summary.warmTotalMs.max}`,
    `warmEnsureMs: avg=${report.summary.warmEnsureMs.avg} p50=${report.summary.warmEnsureMs.p50} p95=${report.summary.warmEnsureMs.p95} max=${report.summary.warmEnsureMs.max}`,
    `warmResolveMs: avg=${report.summary.warmResolveMs.avg} p50=${report.summary.warmResolveMs.p50} p95=${report.summary.warmResolveMs.p95} max=${report.summary.warmResolveMs.max}`,
    `eventLoopDelayMaxMs: avg=${report.summary.eventLoopDelayMaxMs.avg} max=${report.summary.eventLoopDelayMaxMs.max}`,
    `rssMb: avg=${report.summary.rssMb.avg} max=${report.summary.rssMb.max}`,
  ];
  if (report.options.output) {
    lines.push(`output: ${report.options.output}`);
  }
  if (report.cpuProfilePath ?? cpuProfilePath) {
    lines.push(`cpuProfile: ${report.cpuProfilePath ?? cpuProfilePath}`);
  }
  process.stdout.write(`${lines.join("\n")}\n`);
}

async function main(): Promise<void> {
  if (hasFlag("--help") || hasFlag("-h")) {
    printUsage();
    return;
  }
  const options = parseOptions();
  const tempRoot = await mkdtemp(path.join(tmpdir(), "openclaw-issue-78851-"));
  const workspaceDir = path.join(tempRoot, "workspace");
  await mkdir(workspaceDir, { recursive: true });
  const config = buildConfig(options, workspaceDir);
  let profiler: Awaited<ReturnType<typeof startCpuProfile>> | undefined;
  let cpuProfilePath: string | undefined;
  try {
    if (options.cpuProfDir ?? options.cpuProfOutput) {
      profiler = await startCpuProfile({
        dir: options.cpuProfDir,
        output: options.cpuProfOutput,
      });
    }
    for (let index = 0; index < options.warmup; index += 1) {
      await runOne({ config, index: -index - 1, options, tempRoot, workspaceDir });
    }
    const samples: RunSample[] = [];
    for (let index = 0; index < options.runs; index += 1) {
      samples.push(await runOne({ config, index, options, tempRoot, workspaceDir }));
    }
    if (profiler) {
      cpuProfilePath = await profiler.stop();
      profiler = undefined;
    }
    const report: Report = {
      options: {
        agentCount: options.agentCount,
        cpuProfDir: options.cpuProfDir,
        cpuProfOutput: options.cpuProfOutput,
        lookupsPerRun: options.lookupsPerRun,
        modelsPerProvider: options.modelsPerProvider,
        output: options.output,
        providers: options.providers,
        runs: options.runs,
        runtimeHooks: options.runtimeHooks,
        warmup: options.warmup,
      },
      samples,
      scenario: "issue-78851-model-resolution",
      summary: summarize(samples),
      tempRoot,
      ...(cpuProfilePath ? { cpuProfilePath } : {}),
    };
    if (options.output) {
      await mkdir(path.dirname(options.output), { recursive: true });
      await writeFile(options.output, `${JSON.stringify(report, null, 2)}\n`);
    }
    if (options.json) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      printHuman(report, cpuProfilePath);
    }
  } finally {
    if (profiler) {
      await profiler.stop().catch(() => undefined);
    }
    if (!options.keepTemp) {
      await rm(tempRoot, { recursive: true, force: true });
    }
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
