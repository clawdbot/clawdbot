import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { expectDefined } from "../../packages/normalization-core/src/expect.ts";
import { delay } from "./gateway-bench-child.ts";
import { requestProbeStatus } from "./gateway-bench-probes.ts";
import { parseStrictIntegerOption } from "./strict-integer-option.ts";

type GatewayBenchCase = {
  config: Record<string, unknown>;
  env?: Record<string, string>;
  id: string;
  name: string;
};

export type SummaryStats = {
  avg: number;
  max: number;
  min: number;
  p50: number;
  p95: number;
};

export type InitialProbeResult = {
  firstErrorKind: string | null;
  firstRecoveryMs: number | null;
  ms: number | null;
  status: number | null;
  transitions: Array<{ errorKind?: string; ms: number; status: number | null }>;
};

type PluginFixtureResult = {
  pluginIds: string[];
  pluginsDir: string;
};

export const STALLED_CATALOG_PROVIDER_ID = "bench-catalog-stall";
export const STALLED_CATALOG_MODEL_ID = "bench-model";

export const BASE_GATEWAY_BENCH_CONFIG = {
  browser: { enabled: false },
  gateway: {
    mode: "local",
    bind: "loopback",
    auth: { mode: "none" },
    controlUi: { enabled: false },
    tailscale: { mode: "off" },
  },
  plugins: { enabled: true, entries: { browser: { enabled: false } } },
} satisfies Record<string, unknown>;

export class CliArgumentError extends Error {
  override name = "CliArgumentError";
}

function readRequiredFlagValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("-")) {
    throw new CliArgumentError(`${flag} requires a value`);
  }
  return value;
}

export function validateCliArgs(
  argv: string[],
  options: {
    booleanFlags: ReadonlySet<string>;
    repeatableValueFlags?: ReadonlySet<string>;
    valueFlags: ReadonlySet<string>;
  },
): void {
  const seenSingleValueFlags = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";
    if (options.booleanFlags.has(arg)) {
      continue;
    }
    if (options.valueFlags.has(arg)) {
      if (!options.repeatableValueFlags?.has(arg)) {
        if (seenSingleValueFlags.has(arg)) {
          throw new CliArgumentError(`${arg} was provided more than once`);
        }
        seenSingleValueFlags.add(arg);
      }
      readRequiredFlagValue(argv, index, arg);
      index += 1;
      continue;
    }
    throw new CliArgumentError(`Unknown argument: ${arg}`);
  }
}

export function parseFlagValue(argv: string[], flag: string): string | undefined {
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === flag) {
      return readRequiredFlagValue(argv, index, flag);
    }
  }
  return undefined;
}

export function hasFlag(argv: string[], flag: string): boolean {
  return argv.includes(flag);
}

export function hasHelpFlag(argv: string[]): boolean {
  return hasFlag(argv, "--help") || hasFlag(argv, "-h");
}

export function parseRepeatableFlag(argv: string[], flag: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === flag) {
      values.push(readRequiredFlagValue(argv, index, flag));
      index += 1;
    }
  }
  return values;
}

export function parsePositiveInt(raw: string | undefined, fallback: number, label: string): number {
  return parseStrictIntegerOption({ fallback, label, min: 1, raw });
}

export function parseNonNegativeInt(
  raw: string | undefined,
  fallback: number,
  label: string,
): number {
  return parseStrictIntegerOption({ fallback, label, min: 0, raw });
}

export function resolveEntry(raw: string | undefined, fallback: string): string {
  const entry = raw?.trim() || fallback;
  if (entry.includes("\0")) {
    throw new Error("--entry must not contain NUL bytes");
  }
  if (entry.startsWith("-")) {
    throw new Error(`--entry must be a file path, not a Node option: ${JSON.stringify(entry)}`);
  }
  return entry;
}

export function resolveOutputPath(raw: string | undefined): string | undefined {
  const output = raw?.trim();
  if (!output) {
    return undefined;
  }
  if (output.includes("\0")) {
    throw new Error("--output must not contain NUL bytes");
  }
  return output;
}

export function resolveCases<T extends GatewayBenchCase>(
  caseIds: string[],
  cases: readonly T[],
  options: { allByDefault: boolean; validateDuplicatesFirst?: boolean },
): T[] {
  if (caseIds.length === 0) {
    return options.allByDefault
      ? [...cases]
      : [expectDefined(cases[0], "default gateway benchmark case")];
  }
  const seenIds = new Set<string>();
  if (options.validateDuplicatesFirst) {
    for (const id of caseIds) {
      if (seenIds.has(id)) {
        throw new CliArgumentError(`Duplicate --case "${id}"`);
      }
      seenIds.add(id);
    }
    seenIds.clear();
  }
  const byId = new Map(cases.map((benchCase) => [benchCase.id, benchCase]));
  return caseIds.map((id) => {
    if (seenIds.has(id)) {
      throw new CliArgumentError(`Duplicate --case "${id}"`);
    }
    seenIds.add(id);
    const benchCase = byId.get(id);
    if (!benchCase) {
      throw new Error(`Unknown --case "${id}"`);
    }
    return benchCase;
  });
}

function median(values: number[]): number {
  const sorted = [...values].toSorted((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (
      (expectDefined(sorted[middle - 1], "lower middle gateway benchmark sample") +
        expectDefined(sorted[middle], "upper middle gateway benchmark sample")) /
      2
    );
  }
  return sorted[middle] ?? 0;
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].toSorted((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[index] ?? 0;
}

export function summarizeNumbers(values: number[]): SummaryStats | null {
  if (values.length === 0) {
    return null;
  }
  const total = values.reduce((sum, value) => sum + value, 0);
  return {
    avg: total / values.length,
    max: Math.max(...values),
    min: Math.min(...values),
    p50: median(values),
    p95: percentile(values, 95),
  };
}

export function formatMs(value: number | null): string {
  return value == null ? "n/a" : `${value.toFixed(1)}ms`;
}

export function formatMb(value: number | null): string {
  return value == null ? "n/a" : `${value.toFixed(1)}MB`;
}

export function formatStats(stats: SummaryStats | null | undefined): string {
  if (!stats) {
    return "n/a";
  }
  return `p50=${formatMs(stats.p50)} avg=${formatMs(stats.avg)} min=${formatMs(stats.min)} max=${formatMs(stats.max)}`;
}

export function createGatewayBenchEnv(
  root: string,
  configPath: string,
  options: {
    caseEnv?: Record<string, string> | undefined;
    restartTrace?: boolean | undefined;
  },
): NodeJS.ProcessEnv {
  return {
    CI: process.env.CI ?? "1",
    HOME: root,
    LANG: process.env.LANG ?? "en_US.UTF-8",
    LOGNAME: process.env.LOGNAME ?? "openclaw-bench",
    NO_COLOR: "1",
    PATH: process.env.PATH,
    SHELL: process.env.SHELL,
    TMPDIR: process.env.TMPDIR,
    USER: process.env.USER ?? "openclaw-bench",
    npm_config_update_notifier: "false",
    OPENCLAW_CONFIG_PATH: configPath,
    ...(options.restartTrace ? { OPENCLAW_GATEWAY_RESTART_TRACE: "1" } : {}),
    OPENCLAW_GATEWAY_STARTUP_TRACE: "1",
    OPENCLAW_HOME: root,
    OPENCLAW_NO_RESPAWN: "1",
    OPENCLAW_STATE_DIR: path.join(root, "state"),
    OPENCLAW_TEST_DISABLE_UPDATE_CHECK: "1",
    ...options.caseEnv,
  };
}

export function writePluginFixtures(
  root: string,
  options: {
    activationOnStartup?: boolean | undefined;
    count: number;
    providerCatalogStallMs?: number | undefined;
    providerStaticCatalogModelCount?: number | undefined;
    providerStaticCatalogStallMs?: number | undefined;
  },
): PluginFixtureResult {
  const pluginIds: string[] = [];
  const pluginsDir = path.join(root, "plugins");
  mkdirSync(pluginsDir, { recursive: true });
  for (let index = 0; index < options.count; index += 1) {
    const id = `bench-plugin-${String(index + 1).padStart(2, "0")}`;
    const stallsProviderCatalog = options.providerCatalogStallMs !== undefined && index === 0;
    const stallsProviderStaticCatalog =
      options.providerStaticCatalogStallMs !== undefined && index === 0;
    pluginIds.push(id);
    const pluginDir = path.join(pluginsDir, id);
    mkdirSync(pluginDir, { recursive: true });
    const models = Array.from(
      {
        length: stallsProviderStaticCatalog ? (options.providerStaticCatalogModelCount ?? 1) : 1,
      },
      (_, modelIndex) => ({
        id:
          modelIndex === 0
            ? STALLED_CATALOG_MODEL_ID
            : `${STALLED_CATALOG_MODEL_ID}-${modelIndex + 1}`,
        name: `Benchmark Model ${modelIndex + 1}`,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 8_192,
      }),
    );
    const provider = {
      baseUrl: "http://127.0.0.1:1/v1",
      api: "openai-completions",
      models,
    };
    const entrySource = stallsProviderCatalog
      ? `const provider = ${JSON.stringify(provider)};\nmodule.exports = { id: ${JSON.stringify(id)}, register(api) { api.registerProvider({ id: ${JSON.stringify(STALLED_CATALOG_PROVIDER_ID)}, label: "Benchmark Catalog Stall", auth: [], catalog: { order: "simple", run: async () => { const stopAt = Date.now() + ${options.providerCatalogStallMs}; while (Date.now() < stopAt) {} return { provider }; } }, staticCatalog: { order: "simple", run: async () => ({ provider }) } }); } };\n`
      : stallsProviderStaticCatalog
        ? `const provider = ${JSON.stringify(provider)};\nmodule.exports = { id: ${JSON.stringify(id)}, register(api) { api.registerProvider({ id: ${JSON.stringify(STALLED_CATALOG_PROVIDER_ID)}, label: "Benchmark Static Catalog Stall", auth: [], staticCatalog: { order: "simple", run: async () => ({ provider }) } }); } };\n`
        : `module.exports = { id: ${JSON.stringify(id)}, register() {} };\n`;
    writeFileSync(path.join(pluginDir, "index.cjs"), entrySource);
    if (stallsProviderStaticCatalog) {
      writeFileSync(
        path.join(pluginDir, "provider-discovery.cjs"),
        `const provider = ${JSON.stringify(provider)};\nlet staticCatalogCallCount = 0;\nmodule.exports = { id: ${JSON.stringify(STALLED_CATALOG_PROVIDER_ID)}, label: "Benchmark Static Catalog Stall", auth: [], staticCatalog: { order: "simple", run: async () => { staticCatalogCallCount += 1; console.log("startup trace: benchmark preparedRuntimeStaticCatalogCallCount=" + staticCatalogCallCount); const stopAt = Date.now() + ${options.providerStaticCatalogStallMs}; while (Date.now() < stopAt) {} return { provider }; } } };\n`,
      );
    }
    writeFileSync(
      path.join(pluginDir, "openclaw.plugin.json"),
      `${JSON.stringify(
        {
          id,
          ...(options.activationOnStartup === undefined
            ? {}
            : { activation: { onStartup: options.activationOnStartup } }),
          ...(stallsProviderCatalog || stallsProviderStaticCatalog
            ? {
                providers: [STALLED_CATALOG_PROVIDER_ID],
                ...(stallsProviderStaticCatalog
                  ? { providerCatalogEntry: "./provider-discovery.cjs" }
                  : {}),
                ...(stallsProviderCatalog
                  ? {
                      modelCatalog: {
                        providers: { [STALLED_CATALOG_PROVIDER_ID]: provider },
                      },
                    }
                  : {}),
              }
            : {}),
          configSchema: { type: "object", additionalProperties: false },
        },
        null,
        2,
      )}\n`,
    );
  }
  return { pluginIds, pluginsDir };
}

export function writeGatewayBenchConfig(
  root: string,
  config: Record<string, unknown>,
  options: {
    agentList?: Array<{ id: string; default?: boolean; workspace: string }> | undefined;
    pluginFixtures?: PluginFixtureResult | null | undefined;
  },
): string {
  const merged = {
    ...config,
    ...(options.agentList
      ? {
          agents: {
            ...(config.agents as Record<string, unknown> | undefined),
            list: options.agentList,
          },
        }
      : {}),
    plugins: {
      ...(config.plugins as Record<string, unknown> | undefined),
      ...(options.pluginFixtures
        ? {
            allow: options.pluginFixtures.pluginIds,
            load: { paths: [options.pluginFixtures.pluginsDir] },
          }
        : {}),
    },
  };
  const configPath = path.join(root, "openclaw.json");
  writeFileSync(configPath, `${JSON.stringify(merged, null, 2)}\n`);
  return configPath;
}

export function buildGatewayBenchChildArgs(
  entry: string,
  port: number,
  nodeOptions: string[] = [],
): string[] {
  return [
    ...nodeOptions,
    entry,
    "gateway",
    "run",
    "--port",
    String(port),
    "--bind",
    "loopback",
    "--auth",
    "none",
    "--tailscale",
    "off",
    "--allow-unconfigured",
  ];
}

export async function waitForInitialProbe(params: {
  deadlineAt: number;
  isDone?: (() => boolean) | undefined;
  path: string;
  port: number;
  startAt: number;
}): Promise<InitialProbeResult> {
  let firstErrorKind: string | null = null;
  let firstRecoveryMs: number | null = null;
  let lastStatus: number | null = null;
  let lastStateKey: string | null = null;
  let sawUnreadyState = false;
  const transitions: InitialProbeResult["transitions"] = [];
  while (performance.now() < params.deadlineAt) {
    if (params.isDone?.()) {
      break;
    }
    const attempt = await requestProbeStatus(params.port, params.path);
    const elapsedMs = performance.now() - params.startAt;
    lastStatus = attempt.status;
    const stateKey = `${attempt.status ?? "none"}:${attempt.errorKind ?? "ok"}`;
    if (stateKey !== lastStateKey) {
      transitions.push({
        ms: elapsedMs,
        status: attempt.status,
        ...(attempt.errorKind ? { errorKind: attempt.errorKind } : {}),
      });
      lastStateKey = stateKey;
    }
    if (attempt.errorKind && firstErrorKind == null) {
      firstErrorKind = attempt.errorKind;
    }
    if (attempt.status !== 200) {
      sawUnreadyState = true;
    }
    if (attempt.status === 200) {
      if (sawUnreadyState && firstRecoveryMs == null) {
        firstRecoveryMs = elapsedMs;
      }
      return {
        firstErrorKind,
        firstRecoveryMs,
        ms: elapsedMs,
        status: attempt.status,
        transitions,
      };
    }
    await delay(25);
  }
  return { firstErrorKind, firstRecoveryMs, ms: null, status: lastStatus, transitions };
}

function parseTraceMetrics(raw: string): Array<{ key: string; value: number }> {
  const metrics: Array<{ key: string; value: number }> = [];
  for (const part of raw.trim().split(/\s+/u)) {
    const match = /^([A-Za-z][A-Za-z0-9]*)=([0-9.]+)(?:ms)?$/u.exec(part);
    if (!match) {
      continue;
    }
    const key = expectDefined(match[1], "gateway trace metric key");
    const value = Number(expectDefined(match[2], `gateway ${key} trace metric value`));
    if (
      Number.isFinite(value) &&
      (key === "eventLoopMax" || key.endsWith("Ms") || key.endsWith("Mb") || key.endsWith("Count"))
    ) {
      metrics.push({ key, value });
    }
  }
  return metrics;
}

export function collectTraceLine(
  line: string,
  prefix: "startup trace" | "restart trace",
  trace: Record<string, number>,
): boolean {
  const escapedPrefix = prefix.replace(" ", "\\s+");
  const phaseMatch = new RegExp(
    `${escapedPrefix}: ([^ ]+) ([0-9.]+)ms total=([0-9.]+)ms(?: (.*))?`,
    "u",
  ).exec(line);
  if (phaseMatch) {
    const phase = expectDefined(phaseMatch[1], `${prefix} phase name`);
    trace[phase] = Number(expectDefined(phaseMatch[2], `${prefix} phase duration`));
    trace[`${phase}.total`] = Number(expectDefined(phaseMatch[3], `${prefix} total duration`));
    for (const metric of parseTraceMetrics(phaseMatch[4] ?? "")) {
      trace[`${phase}.${metric.key}`] = metric.value;
    }
    return true;
  }
  const detailMatch = new RegExp(`${escapedPrefix}: ([^ ]+) (.*)`, "u").exec(line);
  if (!detailMatch) {
    return false;
  }
  const phase = expectDefined(detailMatch[1], `${prefix} detail phase name`);
  for (const metric of parseTraceMetrics(
    expectDefined(detailMatch[2], `${prefix} detail metrics`),
  )) {
    trace[`${phase}.${metric.key}`] = metric.value;
  }
  return true;
}

export function classifyGatewayReadyLog(line: string): "gateway-ready" | "http-listen" | null {
  if (line.includes("[gateway] http server listening (")) {
    return "http-listen";
  }
  return /\[gateway\] ready(?:\s*\(|\s*$)/u.test(line) ? "gateway-ready" : null;
}

export function collectOutputLines(
  carry: string,
  chunk: string,
): { carry: string; lines: string[] } {
  const parts = `${carry}${chunk}`.split(/\r?\n/u);
  return { carry: parts.pop() ?? "", lines: parts };
}

export function flushOutputLineBuffers(
  buffers: Record<"stderr" | "stdout", string>,
  onLine: (line: string, nowMs: number) => void,
  nowMs: number,
  options: { flushPartial?: boolean } = {},
): void {
  if (!options.flushPartial) {
    return;
  }
  for (const stream of ["stdout", "stderr"] as const) {
    const line = buffers[stream];
    if (line) {
      buffers[stream] = "";
      onLine(line, nowMs);
    }
  }
}
