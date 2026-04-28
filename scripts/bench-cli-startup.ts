import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

type CommandCase = {
  id: string;
  name: string;
  args: string[];
  presets: readonly string[];
};

type Sample = {
  ms: number;
  maxRssMb: number | null;
  exitCode: number | null;
  signal: string | null;
};

type SummaryStats = {
  avg: number;
  p50: number;
  p95: number;
  min: number;
  max: number;
};

type CaseSummary = {
  sampleCount: number;
  durationMs: SummaryStats;
  maxRssMb: SummaryStats | null;
  exitSummary: string;
};

type SuiteResult = {
  entry: string;
  cases: Array<{
    id: string;
    name: string;
    args: string[];
    samples: Sample[];
    summary: CaseSummary;
  }>;
};

type CliOptions = {
  cases: CommandCase[];
  entryPrimary: string;
  entrySecondary?: string;
  runs: number;
  warmup: number;
  timeoutMs: number;
  json: boolean;
  output?: string;
  cpuProfDir?: string;
  heapProfDir?: string;
};

const DEFAULT_RUNS = 5;
const DEFAULT_WARMUP = 1;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_ENTRY = "openclaw.mjs";
const MAX_RSS_MARKER = "__OPENCLAW_MAX_RSS_KB__=";

const COMMAND_CASES: readonly CommandCase[] = [
  { id: "version", name: "--version", args: ["--version"], presets: ["startup"] },
  { id: "help", name: "--help", args: ["--help"], presets: ["startup"] },
  { id: "health", name: "health", args: ["health"], presets: ["startup", "real"] },
  { id: "healthJson", name: "health --json", args: ["health", "--json"], presets: ["startup"] },
  {
    id: "statusJson",
    name: "status --json",
    args: ["status", "--json"],
    presets: ["startup", "real"],
  },
  { id: "status", name: "status", args: ["status"], presets: ["startup", "real"] },
  { id: "sessions", name: "sessions", args: ["sessions"], presets: ["real"] },
  {
    id: "sessionsJson",
    name: "sessions --json",
    args: ["sessions", "--json"],
    presets: ["real"],
  },
  {
    id: "tasksJson",
    name: "tasks --json",
    args: ["tasks", "--json"],
    presets: ["real"],
  },
  {
    id: "tasksListJson",
    name: "tasks list --json",
    args: ["tasks", "list", "--json"],
    presets: ["real"],
  },
  {
    id: "tasksAuditJson",
    name: "tasks audit --json",
    args: ["tasks", "audit", "--json"],
    presets: ["real"],
  },
  {
    id: "agentsListJson",
    name: "agents list --json",
    args: ["agents", "list", "--json"],
    presets: ["real"],
  },
  {
    id: "gatewayStatus",
    name: "gateway status",
    args: ["gateway", "status"],
    presets: ["real"],
  },
  {
    id: "gatewayStatusJson",
    name: "gateway status --json",
    args: ["gateway", "status", "--json"],
    presets: ["real"],
  },
  {
    id: "gatewayHealthJson",
    name: "gateway health --json",
    args: ["gateway", "health", "--json"],
    presets: ["real"],
  },
  {
    id: "configGetGatewayPort",
    name: "config get gateway.port",
    args: ["config", "get", "gateway.port"],
    presets: ["real"],
  },
] as const;

function parseFlagValue(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  if (idx === -1) {
    return undefined;
  }
  return process.argv[idx + 1];
}

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

function parseRepeatableFlag(flag: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < process.argv.length; i += 1) {
    if (process.argv[i] === flag && process.argv[i + 1]) {
      values.push(process.argv[i + 1]);
    }
  }
  return values;
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  return parsed;
}

function parsePresets(raw: string | undefined): string[] {
  if (!raw) {
    return ["startup"];
  }
  const values = raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (values.includes("all")) {
    return ["startup", "real"];
  }
  return values.length > 0 ? values : ["startup"];
}

function resolveCases(options: { presets: string[]; caseIds: string[] }): CommandCase[] {
  const byId = new Map(COMMAND_CASES.map((commandCase) => [commandCase.id, commandCase]));
  if (options.caseIds.length > 0) {
    return options.caseIds.map((id) => {
      const commandCase = byId.get(id);
      if (!commandCase) {
        throw new Error(`Unknown --case "${id}"`);
      }
      return commandCase;
    });
  }
  return COMMAND_CASES.filter((commandCase) =>
    commandCase.presets.some((preset) => options.presets.includes(preset)),
  );
}

function median(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].toSorted((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].toSorted((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[index] ?? 0;
}

function summarizeNumbers(values: number[]): SummaryStats {
  const total = values.reduce((sum, value) => sum + value, 0);
  const avg = values.length > 0 ? total / values.length : 0;
  const min = values.length > 0 ? Math.min(...values) : 0;
  const max = values.length > 0 ? Math.max(...values) : 0;
  return {
    avg,
    p50: median(values),
    p95: percentile(values, 95),
    min,
    max,
  };
}

function summarizeSamples(samples: Sample[]): CaseSummary {
  const durations = summarizeNumbers(samples.map((sample) => sample.ms));
  const rssValues = samples
    .map((sample) => sample.maxRssMb)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  return {
    sampleCount: samples.length,
    durationMs: durations,
    maxRssMb: rssValues.length > 0 ? summarizeNumbers(rssValues) : null,
    exitSummary: collectExitSummary(samples),
  };
}

function formatMs(value: number): string {
  return `${value.toFixed(1)}ms`;
}

function formatMb(value: number): string {
  return `${value.toFixed(1)}MB`;
}

function collectExitSummary(samples: Sample[]): string {
  const buckets = new Map<string, number>();
  for (const sample of samples) {
    const key =
      sample.signal != null
        ? `signal:${sample.signal}`
        : `code:${sample.exitCode == null ? "null" : String(sample.exitCode)}`;
    buckets.set(key, (buckets.get(key) ?? 0) + 1);
  }
  return [...buckets.entries()].map(([key, count]) => `${key}x${count}`).join(", ");
}

function buildRssHook(tmpDir: string): string {
  const rssHookPath = path.join(tmpDir, "measure-rss.mjs");
  writeFileSync(
    rssHookPath,
    [
      "process.on('exit', () => {",
      "  const usage = typeof process.resourceUsage === 'function' ? process.resourceUsage() : null;",
      `  if (usage && typeof usage.maxRSS === 'number') console.error('${MAX_RSS_MARKER}' + String(usage.maxRSS));`,
      "});",
      "",
    ].join("\n"),
    "utf8",
  );
  return rssHookPath;
}

function parseMaxRssMb(stderr: string): number | null {
  const matches = [...stderr.matchAll(new RegExp(`^${MAX_RSS_MARKER}(\\d+)\\s*$`, "gm"))];
  const lastMatch = matches.at(-1);
  if (!lastMatch?.[1]) {
    return null;
  }
  return Number(lastMatch[1]) / 1024;
}

function buildCpuOrHeapFlags(options: { cpuProfDir?: string; heapProfDir?: string }): string[] {
  const flags: string[] = [];
  if (options.cpuProfDir) {
    flags.push("--cpu-prof", "--cpu-prof-dir", options.cpuProfDir);
  }
  if (options.heapProfDir) {
    flags.push("--heap-prof", "--heap-prof-dir", options.heapProfDir);
  }
  return flags;
}

function runCase(params: {
  entry: string;
  commandCase: CommandCase;
  runs: number;
  warmup: number;
  timeoutMs: number;
  cpuProfDir?: string;
  heapProfDir?: string;
  rssHookPath: string;
}): Sample[] {
  const samples: Sample[] = [];
  const totalRuns = params.warmup + params.runs;
  for (let i = 0; i < totalRuns; i += 1) {
    const nodeArgs = [
      "--import",
      params.rssHookPath,
      ...buildCpuOrHeapFlags({
        cpuProfDir: params.cpuProfDir,
        heapProfDir: params.heapProfDir,
      }),
      params.entry,
      ...params.commandCase.args,
    ];
    const started = process.hrtime.bigint();
    const proc = spawnSync(process.execPath, nodeArgs, {
      cwd: process.cwd(),
      env: {
        ...process.env,
        OPENCLAW_HIDE_BANNER: "1",
      },
      stdio: ["ignore", "ignore", "pipe"],
      encoding: "utf8",
      timeout: params.timeoutMs,
      maxBuffer: 32 * 1024 * 1024,
    });
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    if (i < params.warmup) {
      continue;
    }
    samples.push({
      ms,
      maxRssMb: parseMaxRssMb(proc.stderr ?? ""),
      exitCode: proc.status,
      signal: proc.signal,
    });
  }
  return samples;
}

function printSuite(result: SuiteResult): void {
  console.log(`Entry: ${result.entry}`);
  for (const commandCase of result.cases) {
    const { durationMs, maxRssMb, exitSummary } = commandCase.summary;
    const rssSummary =
      maxRssMb == null
        ? "rss=n/a"
        : `rss(avg=${formatMb(maxRssMb.avg)} p50=${formatMb(maxRssMb.p50)} p95=${formatMb(maxRssMb.p95)})`;
    console.log(
      `${commandCase.name.padEnd(24)} avg=${formatMs(durationMs.avg)} p50=${formatMs(
        durationMs.p50,
      )} p95=${formatMs(durationMs.p95)} min=${formatMs(durationMs.min)} max=${formatMs(
        durationMs.max,
      )} ${rssSummary} exits=[${exitSummary}]`,
    );
  }
  console.log("");
}

function printDelta(primary: SuiteResult, secondary: SuiteResult): void {
  const primaryById = new Map(primary.cases.map((commandCase) => [commandCase.id, commandCase]));
  console.log("Delta (secondary - primary, avg)");
  for (const commandCase of secondary.cases) {
    const baseline = primaryById.get(commandCase.id);
    if (!baseline) {
      continue;
    }
    const durationDelta = commandCase.summary.durationMs.avg - baseline.summary.durationMs.avg;
    const durationPct =
      baseline.summary.durationMs.avg > 0
        ? (durationDelta / baseline.summary.durationMs.avg) * 100
        : 0;
    const durationSign = durationDelta > 0 ? "+" : "";
    let line = `${commandCase.name.padEnd(24)} ${durationSign}${formatMs(durationDelta)} (${durationSign}${durationPct.toFixed(1)}%)`;
    if (baseline.summary.maxRssMb && commandCase.summary.maxRssMb) {
      const rssDelta = commandCase.summary.maxRssMb.avg - baseline.summary.maxRssMb.avg;
      const rssPct =
        baseline.summary.maxRssMb.avg > 0 ? (rssDelta / baseline.summary.maxRssMb.avg) * 100 : 0;
      const rssSign = rssDelta > 0 ? "+" : "";
      line += ` rss ${rssSign}${formatMb(rssDelta)} (${rssSign}${rssPct.toFixed(1)}%)`;
    }
    console.log(line);
  }
}

function buildSuiteResult(params: {
  entry: string;
  options: CliOptions;
  rssHookPath: string;
}): SuiteResult {
  const cases = params.options.cases.map((commandCase) => {
    const samples = runCase({
      entry: params.entry,
      commandCase,
      runs: params.options.runs,
      warmup: params.options.warmup,
      timeoutMs: params.options.timeoutMs,
      cpuProfDir: params.options.cpuProfDir,
      heapProfDir: params.options.heapProfDir,
      rssHookPath: params.rssHookPath,
    });
    return {
      id: commandCase.id,
      name: commandCase.name,
      args: commandCase.args,
      samples,
      summary: summarizeSamples(samples),
    };
  });
  return {
    entry: params.entry,
    cases,
  };
}

function parseOptions(): CliOptions {
  const presets = parsePresets(parseFlagValue("--preset"));
  const cases = resolveCases({
    presets,
    caseIds: parseRepeatableFlag("--case"),
  });
  return {
    cases,
    entryPrimary: parseFlagValue("--entry-primary") ?? parseFlagValue("--entry") ?? DEFAULT_ENTRY,
    entrySecondary: parseFlagValue("--entry-secondary"),
    runs: parsePositiveInt(parseFlagValue("--runs"), DEFAULT_RUNS),
    warmup: parsePositiveInt(parseFlagValue("--warmup"), DEFAULT_WARMUP),
    timeoutMs: parsePositiveInt(parseFlagValue("--timeout-ms"), DEFAULT_TIMEOUT_MS),
    json: hasFlag("--json"),
    output: parseFlagValue("--output"),
    cpuProfDir: parseFlagValue("--cpu-prof-dir"),
    heapProfDir: parseFlagValue("--heap-prof-dir"),
  };
}

function printUsage(): void {
  console.log(`OpenClaw CLI benchmark

Usage:
  pnpm tsx scripts/bench-cli-startup.ts [options]

Options:
  --preset <startup|real|all>  Command preset to run (default: startup)
  --case <id>                  Specific case id to run; repeatable
  --entry <path>               Primary entry file (default: openclaw.mjs)
  --entry-secondary <path>     Secondary entry file for avg delta comparison
  --runs <n>                   Measured runs per case (default: ${DEFAULT_RUNS})
  --warmup <n>                 Warmup runs per case (default: ${DEFAULT_WARMUP})
  --timeout-ms <ms>            Per-run timeout (default: ${DEFAULT_TIMEOUT_MS})
  --output <path>              Write machine-readable JSON to a file
  --cpu-prof-dir <dir>         Write V8 CPU profiles for each run
  --heap-prof-dir <dir>        Write V8 heap profiles for each run
  --json                       Emit machine-readable JSON
  --help                       Show this text

Case ids:
  ${COMMAND_CASES.map((commandCase) => `${commandCase.id} (${commandCase.name})`).join("\n  ")}
`);
}

async function main(): Promise<void> {
  if (hasFlag("--help")) {
    printUsage();
    return;
  }

  const options = parseOptions();
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "openclaw-cli-bench-"));
  const rssHookPath = buildRssHook(tmpDir);
  try {
    const primary = buildSuiteResult({
      entry: options.entryPrimary,
      options,
      rssHookPath,
    });
    const secondary = options.entrySecondary
      ? buildSuiteResult({
          entry: options.entrySecondary,
          options,
          rssHookPath,
        })
      : undefined;

    const report = {
      node: process.version,
      runs: options.runs,
      warmup: options.warmup,
      timeoutMs: options.timeoutMs,
      cpuProfDir: options.cpuProfDir ?? null,
      heapProfDir: options.heapProfDir ?? null,
      primary,
      secondary: secondary ?? null,
    };

    if (options.output) {
      mkdirSync(path.dirname(options.output), { recursive: true });
      writeFileSync(options.output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    }

    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }

    console.log(`Node: ${process.version}`);
    console.log(`Runs per case: ${options.runs}`);
    console.log(`Warmup runs per case: ${options.warmup}`);
    console.log(`Timeout: ${options.timeoutMs}ms`);
    if (options.cpuProfDir) {
      console.log(`CPU profiles: ${options.cpuProfDir}`);
    }
    if (options.heapProfDir) {
      console.log(`Heap profiles: ${options.heapProfDir}`);
    }
    console.log("");

    console.log("Primary entry");
    printSuite(primary);
    if (secondary) {
      console.log("Secondary entry");
      printSuite(secondary);
      printDelta(primary, secondary);
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

await main();
