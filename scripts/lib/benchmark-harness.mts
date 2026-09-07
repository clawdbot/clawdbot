import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { classifyBoundedUnsignedDecimal } from "./arg-utils.mts";

type BenchmarkCliOptions = {
  help: boolean;
  json: boolean;
  output?: string;
};

export type BenchmarkTimingSummary = {
  count: number;
  min: number;
  p50: number;
  max: number;
  p95?: number;
  p99?: number;
};

export type BenchmarkWorkerProcessResult = {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error & { code?: string };
};

export type BenchmarkWorkerSpawner = (
  command: string,
  args: string[],
  options: {
    cwd: string;
    encoding: "utf8";
    env: NodeJS.ProcessEnv;
    timeout: number;
    killSignal: NodeJS.Signals;
    maxBuffer: number;
  },
) => BenchmarkWorkerProcessResult;

export function parseBenchmarkInteger(raw: string, flag: string, min: number, max: number) {
  const result = classifyBoundedUnsignedDecimal(raw, min, max);
  if (result.kind === "syntax") {
    throw new Error(`${flag} must be an integer`);
  }
  if (result.kind === "below") {
    throw new Error(`${flag} must be at least ${min}`);
  }
  if (result.kind === "above") {
    throw new Error(`${flag} must be at most ${max}`);
  }
  return result.value;
}

export function parseBenchmarkIntegerList(raw: string, flag: string, max: number) {
  if (!raw || raw.split(",").some((value) => value.length === 0)) {
    throw new Error(`${flag} requires a comma-separated integer list`);
  }
  const values = raw.split(",").map((value) => parseBenchmarkInteger(value, flag, 1, max));
  if (new Set(values).size !== values.length) {
    throw new Error(`${flag} contains duplicate values`);
  }
  return values;
}

export function parseBenchmarkOptions<T extends BenchmarkCliOptions>(
  argv: string[],
  defaults: T,
  valueFlags: Record<string, (options: T, value: string) => void>,
) {
  const options = { ...defaults };
  const seen = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!flag?.startsWith("--")) {
      throw new Error(`Unknown argument: ${flag}`);
    }
    if (seen.has(flag)) {
      throw new Error(`${flag} was provided more than once`);
    }
    seen.add(flag);
    if (flag === "--json" || flag === "--help") {
      options[flag === "--json" ? "json" : "help"] = true;
      continue;
    }
    const applyValue = valueFlags[flag];
    if (!applyValue) {
      throw new Error(`Unknown argument: ${flag}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${flag} requires a value`);
    }
    index += 1;
    applyValue(options, value);
  }
  return options;
}

function percentile(sorted: number[], ratio: number) {
  return sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)] ?? 0;
}

export function summarizeBenchmarkTimings(values: number[]): BenchmarkTimingSummary {
  if (values.length === 0) {
    throw new Error("cannot summarize an empty timing set");
  }
  const sorted = values.toSorted((left, right) => left - right);
  const summary: BenchmarkTimingSummary = {
    count: sorted.length,
    min: sorted[0] ?? 0,
    p50: percentile(sorted, 0.5),
    max: sorted.at(-1) ?? 0,
  };
  if (sorted.length >= 20) {
    summary.p95 = percentile(sorted, 0.95);
    summary.p99 = percentile(sorted, 0.99);
  }
  return summary;
}

export function parseBenchmarkWorkerResult<T>(params: {
  label: string;
  result: BenchmarkWorkerProcessResult;
  sentinel: string;
  timeoutMs: number;
  validate(value: unknown): T;
}) {
  if (params.result.error) {
    const detail =
      params.result.error.code === "ETIMEDOUT"
        ? `timed out after ${params.timeoutMs}ms`
        : params.result.error.message;
    throw new Error(`worker ${params.label} failed: ${detail}`);
  }
  if (params.result.status !== 0) {
    throw new Error(
      `worker ${params.label} failed (${params.result.status ?? "signal"}): ${params.result.stderr.trim() || params.result.stdout.trim()}`,
    );
  }
  const payloads = params.result.stdout
    .split(/\r?\n/u)
    .filter((line) => line.startsWith(params.sentinel));
  if (payloads.length !== 1) {
    throw new Error(`worker ${params.label} returned ${payloads.length} result payloads`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(payloads[0]!.slice(params.sentinel.length));
  } catch {
    throw new Error(`worker ${params.label} returned invalid JSON`);
  }
  return params.validate(parsed);
}

export function runBenchmarkWorker<T>(params: {
  args: string[];
  label: string;
  sentinel: string;
  spawnWorker?: BenchmarkWorkerSpawner;
  timeoutMs: number;
  validate(value: unknown): T;
}) {
  const spawnWorker: BenchmarkWorkerSpawner = params.spawnWorker ?? spawnSync;
  const result = spawnWorker(process.execPath, params.args, {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, NODE_NO_WARNINGS: "1" },
    timeout: params.timeoutMs,
    killSignal: "SIGTERM",
    maxBuffer: 16 * 1024 * 1024,
  });
  return parseBenchmarkWorkerResult({
    label: params.label,
    result,
    sentinel: params.sentinel,
    timeoutMs: params.timeoutMs,
    validate: (value) => params.validate(value),
  });
}

export function runBenchmarkJobs<TJob, TResult>(
  jobs: TJob[],
  options: {
    describe(job: TJob): string;
    now?: () => number;
    prefix: string;
    run(job: TJob): TResult;
    writeProgress?: (line: string) => void;
  },
) {
  const now = options.now ?? Date.now;
  const writeProgress =
    options.writeProgress ?? ((line: string) => process.stderr.write(`${line}\n`));
  return jobs.map((job, index) => {
    const ordinal = index + 1;
    const description = options.describe(job);
    writeProgress(`[${options.prefix}] worker ${ordinal}/${jobs.length} start ${description}`);
    const startedAt = now();
    try {
      const result = options.run(job);
      const elapsedMs = Math.max(0, now() - startedAt);
      writeProgress(
        `[${options.prefix}] worker ${ordinal}/${jobs.length} complete ${description} elapsed=${(elapsedMs / 1_000).toFixed(3)}s`,
      );
      return result;
    } catch (error) {
      const elapsedMs = Math.max(0, now() - startedAt);
      writeProgress(
        `[${options.prefix}] worker ${ordinal}/${jobs.length} failed ${description} elapsed=${(elapsedMs / 1_000).toFixed(3)}s`,
      );
      throw error;
    }
  });
}

export function emitBenchmarkReport<T>(
  report: T,
  options: BenchmarkCliOptions,
  renderLines: (report: T) => string[],
) {
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (options.output) {
    fs.mkdirSync(path.dirname(path.resolve(options.output)), { recursive: true });
    fs.writeFileSync(options.output, json);
  }
  if (options.json) {
    process.stdout.write(json);
    return;
  }
  const lines = renderLines(report);
  if (lines.length > 0) {
    process.stdout.write(`${lines.join("\n")}\n`);
  }
}

export async function runBenchmarkEntrypoint(name: string, run: () => void | Promise<void>) {
  try {
    await run();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  } finally {
    if (process.exitCode && process.exitCode !== 0) {
      console.error(`[${name}] FAILED (exit ${process.exitCode})`);
    }
  }
}
