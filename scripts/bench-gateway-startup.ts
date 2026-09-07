// Bench Gateway Startup script supports OpenClaw repository automation.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { listBundledPluginPackArtifacts } from "./lib/bundled-plugin-build-entries.mjs";
import { delay, stopChild } from "./lib/gateway-bench-child.ts";
import { getFreePort, readProcessRssMb, readProcessTreeCpuMs } from "./lib/gateway-bench-probes.ts";
import {
  BASE_GATEWAY_BENCH_CONFIG,
  buildGatewayBenchChildArgs,
  classifyGatewayReadyLog,
  CliArgumentError,
  collectOutputLines,
  collectTraceLine,
  createGatewayBenchEnv,
  flushOutputLineBuffers,
  formatMb,
  formatMs,
  formatStats,
  hasFlag,
  hasHelpFlag,
  parseFlagValue,
  parseNonNegativeInt,
  parsePositiveInt,
  parseRepeatableFlag,
  resolveCases as resolveGatewayBenchCases,
  resolveEntry as resolveGatewayBenchEntry,
  resolveOutputPath,
  STALLED_CATALOG_MODEL_ID,
  STALLED_CATALOG_PROVIDER_ID,
  summarizeNumbers,
  type InitialProbeResult,
  type SummaryStats,
  validateCliArgs as validateGatewayBenchCliArgs,
  writeGatewayBenchConfig,
  writePluginFixtures,
  waitForInitialProbe as waitForProbe,
} from "./lib/gateway-bench-runtime.ts";
import { selectSlowStartupTraceDurations } from "./lib/gateway-startup-trace-ranking.js";

type GatewayBenchCase = {
  agentTopology?: "incident-scale" | "single" | "shared-eleven-plus-distinct-one";
  completionTracePhase?: string;
  config: Record<string, unknown>;
  env?: Record<string, string>;
  id: string;
  incidentFixture?: "combined" | "database" | "null-metadata" | "packaged-plugins" | "workspace";
  name: string;
  pluginActivationOnStartup?: boolean;
  pluginCount?: number;
  providerCatalogStallMs?: number;
  providerStaticCatalogModelCount?: number;
  providerStaticCatalogStallMs?: number;
  runByDefault?: boolean;
};

type ProbeResult = InitialProbeResult;

type GatewaySample = {
  completionMs: number | null;
  cpuCoreRatio: number | null;
  cpuMs: number | null;
  exitedBeforeTeardown?: boolean;
  exitCode: number | null;
  firstOutputMs: number | null;
  gatewayReadyLogLine: string | null;
  gatewayReadyLogMs: number | null;
  healthz: ProbeResult;
  httpListenLogLine: string | null;
  httpListenLogMs: number | null;
  maxRssMb: number | null;
  outputTail: string;
  readyz: ProbeResult;
  signal: string | null;
  startupTrace: Record<string, number>;
};

type CaseResult = {
  id: string;
  name: string;
  samples: GatewaySample[];
  summary: {
    completionMs: SummaryStats | null;
    firstOutputMs: SummaryStats | null;
    cpuCoreRatio: SummaryStats | null;
    cpuMs: SummaryStats | null;
    gatewayReadyLogMs: SummaryStats | null;
    healthzMs: SummaryStats | null;
    httpListenLogMs: SummaryStats | null;
    maxRssMb: SummaryStats | null;
    readyzMs: SummaryStats | null;
    startupTrace: Record<string, SummaryStats>;
  };
};

type BenchmarkFailure = {
  id: string;
  reason: string;
  sampleIndex: number;
};

type CliOptions = {
  cases: GatewayBenchCase[];
  cpuProfDir?: string;
  entry: string;
  heapProfDir?: string;
  json: boolean;
  output?: string;
  runs: number;
  timeoutMs: number;
  warmup: number;
};

const DEFAULT_RUNS = 5;
const DEFAULT_WARMUP = 1;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_ENTRY = "dist/entry.js";
const INCIDENT_COMBINED_HEALTHZ_P95_MAX_MS = 30_000;
const INCIDENT_COMBINED_READYZ_P95_MAX_MS = 60_000;
const BOOLEAN_FLAGS = new Set(["--help", "-h", "--json"]);
const VALUE_FLAGS = new Set([
  "--case",
  "--cpu-prof-dir",
  "--entry",
  "--heap-prof-dir",
  "--output",
  "--runs",
  "--timeout-ms",
  "--warmup",
]);

const BASE_CONFIG = BASE_GATEWAY_BENCH_CONFIG;
const LARGE_PLUGIN_MODEL_AGENT_COUNT = 256;
const LARGE_PLUGIN_MODEL_COUNT = 58;
const LARGE_PLUGIN_MODEL_PROVIDER_IDS = ["openai", "google", "minimax"] as const;

function buildLargePluginModelAgentEntries() {
  const model = {
    primary: `${LARGE_PLUGIN_MODEL_PROVIDER_IDS[0]}/model-01`,
    fallbacks: Array.from({ length: LARGE_PLUGIN_MODEL_COUNT - 1 }, (_, offset) => {
      const index = offset + 1;
      const provider =
        index % 3 === 0
          ? LARGE_PLUGIN_MODEL_PROVIDER_IDS[0]
          : index % 3 === 1
            ? LARGE_PLUGIN_MODEL_PROVIDER_IDS[1]
            : LARGE_PLUGIN_MODEL_PROVIDER_IDS[2];
      return `${provider}/model-${String(index + 1).padStart(2, "0")}`;
    }),
  };
  return Object.fromEntries(
    Array.from({ length: LARGE_PLUGIN_MODEL_AGENT_COUNT }, (_, index) => [
      `agent-${String(index + 1).padStart(4, "0")}`,
      { model },
    ]),
  );
}

const GATEWAY_CASES: readonly GatewayBenchCase[] = [
  {
    id: "default",
    name: "gateway default",
    config: BASE_CONFIG,
  },
  {
    id: "skipChannels",
    name: "gateway, skip channels",
    env: { OPENCLAW_SKIP_CHANNELS: "1" },
    config: BASE_CONFIG,
  },
  {
    id: "preparedRuntimeCatalogStall",
    name: "gateway, prepared runtime with CPU-stalling live catalog",
    env: { OPENCLAW_SKIP_CHANNELS: "1" },
    providerCatalogStallMs: 2_000,
    config: {
      ...BASE_CONFIG,
      agents: {
        defaults: {
          model: { primary: `${STALLED_CATALOG_PROVIDER_ID}/${STALLED_CATALOG_MODEL_ID}` },
          models: {
            [`${STALLED_CATALOG_PROVIDER_ID}/${STALLED_CATALOG_MODEL_ID}`]: {
              agentRuntime: { id: "openclaw" },
            },
          },
        },
      },
    },
  },
  {
    id: "preparedRuntimeScaleOne",
    name: "gateway, prepared runtime scale with one agent",
    agentTopology: "single",
    completionTracePhase: "sidecars.ready",
    env: { OPENCLAW_SKIP_CHANNELS: "1" },
    providerStaticCatalogModelCount: 64,
    providerStaticCatalogStallMs: 100,
    config: {
      ...BASE_CONFIG,
      agents: {
        defaults: {
          model: { primary: `${STALLED_CATALOG_PROVIDER_ID}/${STALLED_CATALOG_MODEL_ID}` },
          models: {
            [`${STALLED_CATALOG_PROVIDER_ID}/${STALLED_CATALOG_MODEL_ID}`]: {
              agentRuntime: { id: "openclaw" },
            },
          },
        },
      },
    },
  },
  {
    id: "preparedRuntimeScaleMany",
    name: "gateway, prepared runtime scale with 11 shared-workspace agents and one distinct",
    agentTopology: "shared-eleven-plus-distinct-one",
    completionTracePhase: "sidecars.ready",
    env: { OPENCLAW_SKIP_CHANNELS: "1" },
    providerStaticCatalogModelCount: 64,
    providerStaticCatalogStallMs: 100,
    config: {
      ...BASE_CONFIG,
      agents: {
        defaults: {
          model: { primary: `${STALLED_CATALOG_PROVIDER_ID}/${STALLED_CATALOG_MODEL_ID}` },
          models: {
            [`${STALLED_CATALOG_PROVIDER_ID}/${STALLED_CATALOG_MODEL_ID}`]: {
              agentRuntime: { id: "openclaw" },
            },
          },
        },
      },
    },
  },
  {
    id: "oneInternalHook",
    name: "gateway, one configured internal hook",
    env: { OPENCLAW_SKIP_CHANNELS: "1" },
    config: {
      ...BASE_CONFIG,
      hooks: {
        internal: {
          entries: {
            "session-memory": { enabled: true },
          },
        },
      },
    },
  },
  {
    id: "allInternalHooks",
    name: "gateway, all internal hooks",
    env: { OPENCLAW_SKIP_CHANNELS: "1" },
    config: {
      ...BASE_CONFIG,
      hooks: {
        internal: {
          enabled: true,
        },
      },
    },
  },
  {
    id: "fiftyPlugins",
    name: "gateway, 50 manifest plugins",
    env: { OPENCLAW_SKIP_CHANNELS: "1" },
    pluginActivationOnStartup: true,
    pluginCount: 50,
    config: BASE_CONFIG,
  },
  {
    id: "fiftyStartupLazyPlugins",
    name: "gateway, 50 startup-lazy manifest plugins",
    env: { OPENCLAW_SKIP_CHANNELS: "1" },
    pluginActivationOnStartup: false,
    pluginCount: 50,
    config: BASE_CONFIG,
  },
  {
    id: "largePluginModelConfig",
    name: `gateway, ${LARGE_PLUGIN_MODEL_AGENT_COUNT} agents with ${LARGE_PLUGIN_MODEL_COUNT} plugin-owned model refs each`,
    completionTracePhase: "config.snapshot.auto-enable",
    env: { OPENCLAW_SKIP_CHANNELS: "1" },
    runByDefault: false,
    config: {
      ...BASE_CONFIG,
      agents: {
        ownership: "explicit",
        entries: buildLargePluginModelAgentEntries(),
      },
      plugins: {
        enabled: true,
        allow: [...LARGE_PLUGIN_MODEL_PROVIDER_IDS],
      },
    },
  },
  {
    id: "incidentDatabase",
    name: "gateway, incident-scale database",
    incidentFixture: "database",
    runByDefault: false,
    config: BASE_CONFIG,
  },
  {
    id: "incidentNullMetadata",
    name: "gateway, incident-scale NULL metadata repair",
    incidentFixture: "null-metadata",
    runByDefault: false,
    config: BASE_CONFIG,
  },
  {
    id: "incidentWorkspace",
    name: "gateway, incident-scale workspace",
    agentTopology: "incident-scale",
    incidentFixture: "workspace",
    runByDefault: false,
    config: BASE_CONFIG,
  },
  {
    id: "incidentPackagedPlugins",
    name: "gateway, packaged plugin inventory",
    env: { OPENCLAW_DISABLE_BUNDLED_ENTRY_SOURCE_FALLBACK: "1" },
    incidentFixture: "packaged-plugins",
    runByDefault: false,
    config: BASE_CONFIG,
  },
  {
    id: "incidentCombined",
    name: "gateway, incident-scale combined load",
    agentTopology: "incident-scale",
    env: { OPENCLAW_DISABLE_BUNDLED_ENTRY_SOURCE_FALLBACK: "1" },
    incidentFixture: "combined",
    runByDefault: false,
    config: BASE_CONFIG,
  },
] as const;

function validateCliArgs(argv: string[]): void {
  validateGatewayBenchCliArgs(argv, {
    booleanFlags: BOOLEAN_FLAGS,
    repeatableValueFlags: new Set(["--case"]),
    valueFlags: VALUE_FLAGS,
  });
}

function resolveEntry(raw: string | undefined): string {
  return resolveGatewayBenchEntry(raw, DEFAULT_ENTRY);
}

function resolveCases(caseIds: string[]): GatewayBenchCase[] {
  const defaultCases = GATEWAY_CASES.filter((benchCase) => benchCase.runByDefault !== false);
  return resolveGatewayBenchCases(caseIds, caseIds.length === 0 ? defaultCases : GATEWAY_CASES, {
    allByDefault: true,
    validateDuplicatesFirst: true,
  });
}

function parseOptions(argv: string[] = process.argv.slice(2)): CliOptions {
  validateCliArgs(argv);
  return {
    cases: resolveCases(parseRepeatableFlag(argv, "--case")),
    cpuProfDir: parseFlagValue(argv, "--cpu-prof-dir"),
    entry: resolveEntry(parseFlagValue(argv, "--entry")),
    heapProfDir: parseFlagValue(argv, "--heap-prof-dir"),
    json: hasFlag(argv, "--json"),
    output: resolveOutputPath(parseFlagValue(argv, "--output")),
    runs: parsePositiveInt(parseFlagValue(argv, "--runs"), DEFAULT_RUNS, "--runs"),
    timeoutMs: parsePositiveInt(
      parseFlagValue(argv, "--timeout-ms"),
      DEFAULT_TIMEOUT_MS,
      "--timeout-ms",
    ),
    warmup: parseNonNegativeInt(parseFlagValue(argv, "--warmup"), DEFAULT_WARMUP, "--warmup"),
  };
}

function printUsage(): void {
  console.log(`OpenClaw Gateway startup benchmark

Usage:
  pnpm test:startup:gateway -- [options]
  node --import tsx scripts/bench-gateway-startup.ts [options]

Options:
  --case <id>          Specific case id to run; repeatable
  --entry <path>       Gateway CLI entry file (default: ${DEFAULT_ENTRY})
  --runs <n>           Measured runs per case (default: ${DEFAULT_RUNS})
  --warmup <n>         Warmup runs per case (default: ${DEFAULT_WARMUP})
  --timeout-ms <ms>    Per-run timeout (default: ${DEFAULT_TIMEOUT_MS})
  --cpu-prof-dir <dir> Write one V8 CPU profile per run
  --heap-prof-dir <dir> Write one V8 heap profile per run
  --output <path>      Write machine-readable JSON to a file
  --json               Emit machine-readable JSON
  --help, -h           Show this text

Case ids:
  ${GATEWAY_CASES.map((benchCase) => `${benchCase.id} (${benchCase.name})`).join("\n  ")}
`);
}

function summarizeCase(benchCase: GatewayBenchCase, samples: GatewaySample[]): CaseResult {
  const startupTraceKeys = new Set<string>();
  for (const sample of samples) {
    for (const key of Object.keys(sample.startupTrace)) {
      startupTraceKeys.add(key);
    }
  }
  const startupTrace: Record<string, SummaryStats> = {};
  for (const key of [...startupTraceKeys].toSorted()) {
    const stats = summarizeNumbers(
      samples
        .map((sample) => sample.startupTrace[key])
        .filter((value): value is number => typeof value === "number"),
    );
    if (stats) {
      startupTrace[key] = stats;
    }
  }
  return {
    id: benchCase.id,
    name: benchCase.name,
    samples,
    summary: {
      completionMs: summarizeNumbers(
        samples
          .map((sample) => sample.completionMs)
          .filter((value): value is number => typeof value === "number"),
      ),
      firstOutputMs: summarizeNumbers(
        samples
          .map((sample) => sample.firstOutputMs)
          .filter((value): value is number => typeof value === "number"),
      ),
      cpuCoreRatio: summarizeNumbers(
        samples
          .map((sample) => sample.cpuCoreRatio)
          .filter((value): value is number => typeof value === "number"),
      ),
      cpuMs: summarizeNumbers(
        samples
          .map((sample) => sample.cpuMs)
          .filter((value): value is number => typeof value === "number"),
      ),
      gatewayReadyLogMs: summarizeNumbers(
        samples
          .map((sample) => sample.gatewayReadyLogMs)
          .filter((value): value is number => typeof value === "number"),
      ),
      healthzMs: summarizeNumbers(
        samples
          .map((sample) => sample.healthz.ms)
          .filter((value): value is number => typeof value === "number"),
      ),
      httpListenLogMs: summarizeNumbers(
        samples
          .map((sample) => sample.httpListenLogMs)
          .filter((value): value is number => typeof value === "number"),
      ),
      maxRssMb: summarizeNumbers(
        samples
          .map((sample) => sample.maxRssMb)
          .filter((value): value is number => typeof value === "number"),
      ),
      readyzMs: summarizeNumbers(
        samples
          .map((sample) => sample.readyz.ms)
          .filter((value): value is number => typeof value === "number"),
      ),
      startupTrace,
    },
  };
}

function collectResultFailures(results: CaseResult[]): BenchmarkFailure[] {
  const failures: BenchmarkFailure[] = [];
  for (const result of results) {
    result.samples.forEach((sample, index) => {
      const missing: string[] = [];
      if (sample.healthz.status !== 200 || sample.healthz.ms == null) {
        missing.push("/healthz");
      }
      if (sample.readyz.status !== 200 || sample.readyz.ms == null) {
        missing.push("/readyz");
      }
      if (sample.completionMs == null) {
        missing.push("completion");
      }
      if (sample.cpuMs == null || sample.cpuCoreRatio == null) {
        missing.push("cpu");
      }
      if (sample.maxRssMb == null) {
        missing.push("rss");
      }
      if (missing.length > 0) {
        failures.push({
          id: result.id,
          reason: `missing ${missing.join(", ")}`,
          sampleIndex: index + 1,
        });
        return;
      }
      if (sample.exitedBeforeTeardown === true) {
        failures.push({
          id: result.id,
          reason:
            sample.signal == null
              ? `child exited ${sample.exitCode ?? "before teardown"}`
              : `child exited by ${sample.signal}`,
          sampleIndex: index + 1,
        });
      }
    });
    if (result.id !== "incidentCombined") {
      continue;
    }
    const healthzP95 = result.summary.healthzMs?.p95;
    if (healthzP95 == null || healthzP95 >= INCIDENT_COMBINED_HEALTHZ_P95_MAX_MS) {
      failures.push({
        id: result.id,
        reason:
          `/healthz p95 ${healthzP95 == null ? "missing" : formatMs(healthzP95)} ` +
          `must be under ${formatMs(INCIDENT_COMBINED_HEALTHZ_P95_MAX_MS)}`,
        sampleIndex: 0,
      });
    }
    const readyzP95 = result.summary.readyzMs?.p95;
    if (readyzP95 == null || readyzP95 >= INCIDENT_COMBINED_READYZ_P95_MAX_MS) {
      failures.push({
        id: result.id,
        reason:
          `/readyz p95 ${readyzP95 == null ? "missing" : formatMs(readyzP95)} ` +
          `must be under ${formatMs(INCIDENT_COMBINED_READYZ_P95_MAX_MS)}`,
        sampleIndex: 0,
      });
    }
  }
  return failures;
}

function printBenchmarkFailures(failures: BenchmarkFailure[]): void {
  if (failures.length === 0) {
    return;
  }
  console.error(
    `[gateway-startup-bench] failed: ${failures.length} sample(s) did not produce ready probes or process metrics`,
  );
  for (const failure of failures.slice(0, 8)) {
    console.error(
      `[gateway-startup-bench] ${failure.id} ${failure.sampleIndex ? `run ${failure.sampleIndex}` : "summary"}: ${failure.reason}`,
    );
  }
  if (failures.length > 8) {
    console.error(`[gateway-startup-bench] ${failures.length - 8} more sample failure(s) omitted`);
  }
}

function formatRatio(value: number | null): string {
  if (value == null) {
    return "n/a";
  }
  return value.toFixed(3);
}

async function waitForStartupTracePhase(params: {
  deadlineAt: number;
  isDone: () => boolean;
  phase: string;
  startupTrace: Record<string, number>;
}): Promise<number | null> {
  const totalKey = `${params.phase}.total`;
  while (performance.now() < params.deadlineAt) {
    if (Object.hasOwn(params.startupTrace, totalKey)) {
      return params.startupTrace[totalKey] ?? null;
    }
    if (params.isDone()) {
      return null;
    }
    await delay(25);
  }
  return null;
}

function buildBenchAgentList(
  root: string,
  topology: GatewayBenchCase["agentTopology"],
): Array<{ id: string; default?: boolean; workspace: string }> | undefined {
  if (!topology) {
    return undefined;
  }
  const sharedWorkspace = path.join(root, "shared-workspace");
  const distinctWorkspace = path.join(root, "distinct-workspace");
  mkdirSync(sharedWorkspace, { recursive: true });
  if (topology === "single") {
    return [{ id: "main", default: true, workspace: sharedWorkspace }];
  }
  if (topology === "incident-scale") {
    return Array.from({ length: 8 }, (_, index) => ({
      id: `incident-agent-${String(index + 1).padStart(2, "0")}`,
      default: index === 0,
      workspace: path.join(root, "workspaces", `agent-${String(index + 1).padStart(2, "0")}`),
    }));
  }
  mkdirSync(distinctWorkspace, { recursive: true });
  return Array.from({ length: 12 }, (_, index) => ({
    id: `agent-${String(index + 1).padStart(2, "0")}`,
    ...(index === 0 ? { default: true } : {}),
    workspace: index === 11 ? distinctWorkspace : sharedWorkspace,
  }));
}

const INCIDENT_AUDIT_ROW_COUNT = 200_000;
const INCIDENT_WORKSPACE_FILE_BYTES = 10 * 1024;
const INCIDENT_WORKSPACE_FILE_COUNT = 80_000;
const INCIDENT_WORKSPACE_COUNT = 8;
const INCIDENT_WORKSPACE_FILES_PER_DIRECTORY = 1_000;

type IncidentFixtureOptions = {
  auditRowCount?: number;
  kind: NonNullable<GatewayBenchCase["incidentFixture"]>;
  workspaceFileBytes?: number;
  workspaceFileCount?: number;
};

function fixtureIncludesDatabase(kind: IncidentFixtureOptions["kind"]): boolean {
  return kind === "combined" || kind === "database" || kind === "null-metadata";
}

function fixtureIncludesWorkspace(kind: IncidentFixtureOptions["kind"]): boolean {
  return kind === "combined" || kind === "workspace";
}

function fixtureIncludesNullMetadata(kind: IncidentFixtureOptions["kind"]): boolean {
  return kind === "combined" || kind === "null-metadata";
}

function fixtureIncludesPackagedPlugins(kind: IncidentFixtureOptions["kind"]): boolean {
  return kind === "combined" || kind === "packaged-plugins";
}

function listIncidentPackagedPluginArtifacts(env = process.env): string[] {
  return listBundledPluginPackArtifacts({
    env: { ...env, OPENCLAW_BUNDLED_PLUGIN_BUILD_IDS: undefined },
  });
}

function assertIncidentPackagedPluginInventory(): void {
  const missing = listIncidentPackagedPluginArtifacts().filter(
    (artifact) => !existsSync(path.resolve(process.cwd(), artifact)),
  );
  if (missing.length > 0) {
    throw new Error(
      `Incident packaged-plugin benchmark requires a built plugin inventory; ${missing.length} required artifact(s) are missing. Run pnpm build first.`,
    );
  }
}

function createIncidentWorkspaces(root: string, options: IncidentFixtureOptions): void {
  if (!fixtureIncludesWorkspace(options.kind)) {
    return;
  }
  const fileCount = options.workspaceFileCount ?? INCIDENT_WORKSPACE_FILE_COUNT;
  const fileBytes = options.workspaceFileBytes ?? INCIDENT_WORKSPACE_FILE_BYTES;
  const contents = Buffer.alloc(fileBytes, "x");
  for (let index = 0; index < fileCount; index += 1) {
    const workspaceIndex = index % INCIDENT_WORKSPACE_COUNT;
    const directoryIndex = Math.floor(index / INCIDENT_WORKSPACE_FILES_PER_DIRECTORY);
    const directory = path.join(
      root,
      "workspaces",
      `agent-${String(workspaceIndex + 1).padStart(2, "0")}`,
      "incident-artifacts",
      `batch-${String(directoryIndex).padStart(3, "0")}`,
    );
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, `artifact-${String(index).padStart(6, "0")}.bin`), contents);
  }
}

function seedIncidentAuditRows(database: import("node:sqlite").DatabaseSync, count: number): void {
  const payload = `fixture:${"x".repeat(1024)}`;
  const insert = database.prepare(
    `INSERT INTO audit_events (
       event_id, source_id, source_sequence, occurred_at, kind, action, status, actor_type,
       actor_id, agent_id, session_key, run_id, channel, target_ref
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  database.exec("BEGIN IMMEDIATE;");
  try {
    for (let index = 0; index < count; index += 1) {
      const id = `incident-audit-${String(index).padStart(8, "0")}`;
      insert.run(
        id,
        `source-${id}`,
        index + 1,
        1_750_000_000_000 + index,
        "gateway.admission",
        "accepted",
        "ok",
        "system",
        "incident-fixture",
        "incident-agent-01",
        "agent:incident-agent-01:main",
        `run-${id}`,
        "fixture",
        payload,
      );
    }
    database.exec("COMMIT;");
  } catch (error) {
    database.exec("ROLLBACK;");
    throw error;
  }
  // Retain half the rows after a large write so the fixture keeps the incident's
  // high freelist pressure without storing any customer content.
  database.prepare("DELETE FROM audit_events WHERE source_sequence % 2 = 0").run();
}

async function writeIncidentFixture(root: string, options: IncidentFixtureOptions): Promise<void> {
  createIncidentWorkspaces(root, options);
  if (!fixtureIncludesDatabase(options.kind)) {
    return;
  }
  const env = { OPENCLAW_STATE_DIR: path.join(root, "state") };
  const [{ DatabaseSync }, agentDatabase, stateDatabase] = await Promise.all([
    import("node:sqlite"),
    import("../src/state/openclaw-agent-db.js"),
    import("../src/state/openclaw-state-db.js"),
  ]);
  const state = stateDatabase.openOpenClawStateDatabase({ env });
  const agents = Array.from({ length: INCIDENT_WORKSPACE_COUNT }, (_, index) =>
    agentDatabase.openOpenClawAgentDatabase({
      agentId: `incident-agent-${String(index + 1).padStart(2, "0")}`,
      env,
    }),
  );
  const statePath = state.path;
  const agentPaths = agents.map((agent) => agent.path);
  try {
    state.db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    agents.forEach((agent) => agent.db.exec("PRAGMA wal_checkpoint(TRUNCATE);"));
  } finally {
    agentDatabase.closeOpenClawAgentDatabasesForTest();
    stateDatabase.closeOpenClawStateDatabaseForTest();
  }
  const stateHandle = new DatabaseSync(statePath);
  try {
    seedIncidentAuditRows(stateHandle, options.auditRowCount ?? INCIDENT_AUDIT_ROW_COUNT);
    if (fixtureIncludesNullMetadata(options.kind)) {
      stateHandle
        .prepare("UPDATE schema_meta SET app_version = NULL WHERE meta_key = 'primary'")
        .run();
    }
    stateHandle.exec("PRAGMA wal_checkpoint(TRUNCATE);");
  } finally {
    stateHandle.close();
  }
  if (!fixtureIncludesNullMetadata(options.kind)) {
    return;
  }
  for (const agentPath of agentPaths) {
    const agent = new DatabaseSync(agentPath);
    try {
      agent.prepare("UPDATE schema_meta SET app_version = NULL WHERE meta_key = 'primary'").run();
      agent.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    } finally {
      agent.close();
    }
  }
}

async function withGatewayBenchRoot<T>(run: (root: string) => Promise<T>): Promise<T> {
  const root = mkdtempSync(path.join(tmpdir(), "openclaw-gateway-bench-"));
  try {
    return await run(root);
  } finally {
    rmSync(root, { force: true, maxRetries: 3, recursive: true, retryDelay: 100 });
  }
}

function writeConfig(root: string, benchCase: GatewayBenchCase): string {
  const hasCatalogFixture =
    benchCase.providerCatalogStallMs !== undefined ||
    benchCase.providerStaticCatalogStallMs !== undefined;
  const pluginCount = hasCatalogFixture ? 1 : benchCase.pluginCount;
  const pluginFixtures = pluginCount
    ? writePluginFixtures(root, {
        activationOnStartup: hasCatalogFixture ? true : benchCase.pluginActivationOnStartup,
        count: pluginCount,
        providerCatalogStallMs: benchCase.providerCatalogStallMs,
        providerStaticCatalogModelCount: benchCase.providerStaticCatalogModelCount,
        providerStaticCatalogStallMs: benchCase.providerStaticCatalogStallMs,
      })
    : null;
  const agentList = buildBenchAgentList(root, benchCase.agentTopology);
  return writeGatewayBenchConfig(root, benchCase.config, { agentList, pluginFixtures });
}

function sanitizedEnv(
  root: string,
  configPath: string,
  benchCase: GatewayBenchCase,
): NodeJS.ProcessEnv {
  return createGatewayBenchEnv(root, configPath, { caseEnv: benchCase.env });
}

function collectStartupTrace(line: string, startupTrace: Record<string, number>): void {
  collectTraceLine(line, "startup trace", startupTrace);
}

async function runGatewaySample(options: {
  benchCase: GatewayBenchCase;
  cpuProfDir?: string;
  entry: string;
  heapProfDir?: string;
  sampleIndex: number;
  timeoutMs: number;
}): Promise<GatewaySample> {
  return await withGatewayBenchRoot(async (root) => {
    const port = await getFreePort();
    const configPath = writeConfig(root, options.benchCase);
    const env = sanitizedEnv(root, configPath, options.benchCase);
    if (options.benchCase.incidentFixture) {
      await writeIncidentFixture(root, { kind: options.benchCase.incidentFixture });
      if (fixtureIncludesPackagedPlugins(options.benchCase.incidentFixture)) {
        assertIncidentPackagedPluginInventory();
      }
    }
    const startAt = performance.now();
    const deadlineAt = startAt + options.timeoutMs;
    const startupTrace: Record<string, number> = {};
    const output: string[] = [];
    const outputBuffers: Record<"stderr" | "stdout", string> = { stderr: "", stdout: "" };
    let firstOutputMs: number | null = null;
    let gatewayReadyLogLine: string | null = null;
    let gatewayReadyLogMs: number | null = null;
    let httpListenLogLine: string | null = null;
    let httpListenLogMs: number | null = null;
    let maxRssMb: number | null = null;
    let childExited = false;
    let child: ChildProcessWithoutNullStreams | undefined;
    let rssTimer: ReturnType<typeof setInterval> | undefined;

    try {
      const nodeOptions = [
        ...(options.cpuProfDir
          ? [
              "--cpu-prof",
              "--cpu-prof-dir",
              options.cpuProfDir,
              "--cpu-prof-name",
              `openclaw-gateway-${options.benchCase.id}-${options.sampleIndex}-${Date.now()}.cpuprofile`,
            ]
          : []),
        ...(options.heapProfDir ? ["--heap-prof", "--heap-prof-dir", options.heapProfDir] : []),
      ];
      const childArgs = buildGatewayBenchChildArgs(options.entry, port, nodeOptions);
      child = spawn(process.execPath, childArgs, {
        cwd: process.cwd(),
        detached: process.platform !== "win32",
        env,
        stdio: ["pipe", "pipe", "pipe"],
      });
      const startedChild = child;
      const cpuStartMs = readProcessTreeCpuMs(startedChild.pid);
      const sampleRss = () => {
        const rssMb = readProcessRssMb(startedChild.pid);
        if (rssMb != null) {
          maxRssMb = maxRssMb == null ? rssMb : Math.max(maxRssMb, rssMb);
        }
      };
      sampleRss();
      rssTimer = setInterval(sampleRss, 100);
      rssTimer.unref?.();
      const childExitPromise = new Promise<{ exitCode: number | null; signal: string | null }>(
        (resolve) => {
          startedChild.once("exit", (exitCode, signal) => {
            childExited = true;
            resolve({ exitCode, signal });
          });
        },
      );

      const onLine = (line: string, nowMs: number) => {
        const readyLogKind = classifyGatewayReadyLog(line);
        if (readyLogKind === "http-listen" && httpListenLogMs == null) {
          httpListenLogMs = nowMs;
          httpListenLogLine = line;
        }
        if (readyLogKind === "gateway-ready" && gatewayReadyLogMs == null) {
          gatewayReadyLogMs = nowMs;
          gatewayReadyLogLine = line;
        }
        collectStartupTrace(line, startupTrace);
      };
      const onChunk = (stream: "stderr" | "stdout", chunk: Buffer) => {
        if (firstOutputMs == null) {
          firstOutputMs = performance.now() - startAt;
        }
        const text = chunk.toString("utf8");
        output.push(text);
        if (output.length > 20) {
          output.splice(0, output.length - 20);
        }
        const parsed = collectOutputLines(outputBuffers[stream], text);
        outputBuffers[stream] = parsed.carry;
        const nowMs = performance.now() - startAt;
        for (const line of parsed.lines) {
          onLine(line, nowMs);
        }
      };
      startedChild.stdout.on("data", (chunk: Buffer) => onChunk("stdout", chunk));
      startedChild.stderr.on("data", (chunk: Buffer) => onChunk("stderr", chunk));

      const [healthz, readyz] = await Promise.all([
        waitForProbe({
          deadlineAt,
          isDone: () => childExited,
          path: "/healthz",
          port,
          startAt,
        }),
        waitForProbe({
          deadlineAt,
          isDone: () => childExited,
          path: "/readyz",
          port,
          startAt,
        }),
      ]);
      const completionMs = options.benchCase.completionTracePhase
        ? await waitForStartupTracePhase({
            deadlineAt,
            isDone: () => childExited,
            phase: options.benchCase.completionTracePhase,
            startupTrace,
          })
        : performance.now() - startAt;
      const completedAt = performance.now();
      const cpuEndMs = readProcessTreeCpuMs(startedChild.pid);
      const cpuMs =
        cpuStartMs == null || cpuEndMs == null ? null : Math.max(0, cpuEndMs - cpuStartMs);
      const cpuCoreRatio = cpuMs == null ? null : cpuMs / Math.max(1, completedAt - startAt);
      const exit = await stopChild(startedChild);
      sampleRss();
      child = undefined;
      // stopChild is the bounded teardown wait; the raw exit promise may never settle.
      void childExitPromise.catch(() => null);
      flushOutputLineBuffers(outputBuffers, onLine, performance.now() - startAt, {
        flushPartial: true,
      });

      return {
        completionMs,
        cpuCoreRatio,
        cpuMs,
        exitedBeforeTeardown: exit.exitedBeforeTeardown,
        exitCode: exit.exitCode,
        firstOutputMs,
        gatewayReadyLogLine,
        gatewayReadyLogMs,
        healthz,
        httpListenLogLine,
        httpListenLogMs,
        maxRssMb,
        outputTail: output.join("").split(/\r?\n/u).slice(-20).join("\n"),
        readyz,
        signal: exit.signal,
        startupTrace,
      };
    } finally {
      if (rssTimer) {
        clearInterval(rssTimer);
      }
      if (child) {
        await stopChild(child).catch(() => undefined);
      }
    }
  });
}

async function runCase(options: {
  benchCase: GatewayBenchCase;
  cpuProfDir?: string;
  entry: string;
  heapProfDir?: string;
  runs: number;
  timeoutMs: number;
  warmup: number;
}): Promise<CaseResult> {
  const samples: GatewaySample[] = [];
  const total = options.runs + options.warmup;
  for (let index = 0; index < total; index += 1) {
    const sample = await runGatewaySample({
      benchCase: options.benchCase,
      cpuProfDir: options.cpuProfDir,
      entry: options.entry,
      heapProfDir: options.heapProfDir,
      sampleIndex: index + 1,
      timeoutMs: options.timeoutMs,
    });
    if (index >= options.warmup) {
      samples.push(sample);
      const heapUsedMb = sample.startupTrace["memory.ready.heapUsedMb"] ?? null;
      console.log(
        `[gateway-startup-bench] ${options.benchCase.id} run ${samples.length}/${options.runs}: completion=${formatMs(sample.completionMs)} healthz=${formatMs(sample.healthz.ms)} readyz=${formatMs(sample.readyz.ms)} httpListen=${formatMs(sample.httpListenLogMs)} gatewayReady=${formatMs(sample.gatewayReadyLogMs)} cpu=${formatMs(sample.cpuMs)} cpuCore=${formatRatio(sample.cpuCoreRatio)} rss=${formatMb(sample.maxRssMb)} heap=${formatMb(heapUsedMb)}`,
      );
      if (
        sample.outputTail &&
        (sample.completionMs == null ||
          sample.healthz.status !== 200 ||
          sample.readyz.status !== 200)
      ) {
        console.error(
          `[gateway-startup-bench] ${options.benchCase.id} output tail:\n${sample.outputTail}`,
        );
      }
    } else {
      const heapUsedMb = sample.startupTrace["memory.ready.heapUsedMb"] ?? null;
      console.log(
        `[gateway-startup-bench] ${options.benchCase.id} warmup ${index + 1}/${options.warmup}: healthz=${formatMs(sample.healthz.ms)} readyz=${formatMs(sample.readyz.ms)} cpu=${formatMs(sample.cpuMs)} cpuCore=${formatRatio(sample.cpuCoreRatio)} rss=${formatMb(sample.maxRssMb)} heap=${formatMb(heapUsedMb)}`,
      );
    }
  }
  return summarizeCase(options.benchCase, samples);
}

function printResult(result: CaseResult): void {
  console.log(`\n${result.name} (${result.id})`);
  console.log(`  completion:   ${formatStats(result.summary.completionMs)}`);
  console.log(`  first output: ${formatStats(result.summary.firstOutputMs)}`);
  console.log(`  CPU:          ${formatStats(result.summary.cpuMs)}`);
  console.log(`  CPU core:     ${formatStats(result.summary.cpuCoreRatio, formatRatio)}`);
  console.log(`  /healthz:     ${formatStats(result.summary.healthzMs)}`);
  console.log(`  http listen:  ${formatStats(result.summary.httpListenLogMs)}`);
  console.log(`  gateway ready: ${formatStats(result.summary.gatewayReadyLogMs)}`);
  console.log(`  /readyz:      ${formatStats(result.summary.readyzMs)}`);
  console.log(`  max RSS:      ${formatStats(result.summary.maxRssMb, formatMb)}`);
  console.log(
    `  ready memory: rss=${formatStats(result.summary.startupTrace["memory.ready.rssMb"], formatMb)} heap=${formatStats(result.summary.startupTrace["memory.ready.heapUsedMb"], formatMb)} external=${formatStats(result.summary.startupTrace["memory.ready.externalMb"], formatMb)}`,
  );
  console.log(
    `  post-ready memory: rss=${formatStats(result.summary.startupTrace["memory.post-ready.rssMb"], formatMb)} heap=${formatStats(result.summary.startupTrace["memory.post-ready.heapUsedMb"], formatMb)} external=${formatStats(result.summary.startupTrace["memory.post-ready.externalMb"], formatMb)}`,
  );
  console.log(
    `  prepared runtime: agents=${formatStats(result.summary.startupTrace["sidecars.model-runtime-build.agentCount"], String)} workspaces=${formatStats(result.summary.startupTrace["sidecars.model-runtime-build.workspaceGroupCount"], String)} configuredGroups=${formatStats(result.summary.startupTrace["sidecars.model-runtime-build.configuredFactsGroupCount"], String)} configuredModels=${formatStats(result.summary.startupTrace["sidecars.model-runtime-build.configuredRuntimeModelCount"], String)} generatedPlugins=${formatStats(result.summary.startupTrace["sidecars.model-runtime-build.generatedCatalogPluginCount"], String)} generatedReads=${formatStats(result.summary.startupTrace["sidecars.model-runtime-build.generatedCatalogReadCount"], String)} sources=${formatStats(result.summary.startupTrace["sidecars.model-runtime-build.catalogSourceCount"], String)} credentials=${formatStats(result.summary.startupTrace["sidecars.model-runtime-build.credentialGroupCount"], String)} catalogs=${formatStats(result.summary.startupTrace["sidecars.model-runtime-build.catalogGroupCount"], String)} registries=${formatStats(result.summary.startupTrace["sidecars.model-runtime-build.runtimeRegistryCount"], String)} workspaceFacts=${formatStats(result.summary.startupTrace["sidecars.model-runtime-build.workspaceFactsMs"])} runtimePlugins=${formatStats(result.summary.startupTrace["sidecars.model-runtime-build.runtimePluginMs"])} metadata=${formatStats(result.summary.startupTrace["sidecars.model-runtime-build.pluginMetadataMs"])} staticProviders=${formatStats(result.summary.startupTrace["sidecars.model-runtime-build.staticProviderCatalogMs"])} ambientAuth=${formatStats(result.summary.startupTrace["sidecars.model-runtime-build.ambientCredentialsMs"])} agentFacts=${formatStats(result.summary.startupTrace["sidecars.model-runtime-build.agentFactsMs"])} configuredProjection=${formatStats(result.summary.startupTrace["sidecars.model-runtime-build.configuredProjectionMs"])} sourceMs=${formatStats(result.summary.startupTrace["sidecars.model-runtime-build.catalogSourceMs"])} registryMs=${formatStats(result.summary.startupTrace["sidecars.model-runtime-build.registryMs"])} sourceLimit=${formatStats(result.summary.startupTrace["sidecars.model-runtime-build.sourceConcurrencyLimitCount"], String)} fullCatalogLimit=${formatStats(result.summary.startupTrace["sidecars.model-runtime-build.fullCatalogConcurrencyLimitCount"], String)} staticCatalog=${formatStats(result.summary.startupTrace["benchmark.preparedRuntimeStaticCatalogCallCount"], String)} pluginLoader=${formatStats(result.summary.startupTrace["sidecars.plugin-loader.callsCount"], String)} eventLoopMax=${formatStats(result.summary.startupTrace["sidecars.model-runtime.eventLoopMax"])}`,
  );
  const trace = selectSlowStartupTraceDurations(result.summary.startupTrace, 8);
  if (trace.length > 0) {
    console.log("  trace top:");
    for (const [name, stats] of trace) {
      console.log(`    ${name}: ${formatStats(stats)}`);
    }
  }
}

async function main() {
  const argv = process.argv.slice(2);
  if (hasHelpFlag(argv)) {
    printUsage();
    return;
  }

  const options = parseOptions(argv);
  if (options.cpuProfDir) {
    mkdirSync(options.cpuProfDir, { recursive: true });
  }
  if (options.heapProfDir) {
    mkdirSync(options.heapProfDir, { recursive: true });
  }
  const results: CaseResult[] = [];
  for (const benchCase of options.cases) {
    results.push(
      await runCase({
        benchCase,
        cpuProfDir: options.cpuProfDir,
        entry: options.entry,
        heapProfDir: options.heapProfDir,
        runs: options.runs,
        timeoutMs: options.timeoutMs,
        warmup: options.warmup,
      }),
    );
  }

  const payload = {
    entry: options.entry,
    generatedAt: new Date().toISOString(),
    results,
  };
  if (options.output) {
    mkdirSync(path.dirname(options.output), { recursive: true });
    writeFileSync(options.output, `${JSON.stringify(payload, null, 2)}\n`);
  }
  if (options.json) {
    console.log(JSON.stringify(payload, null, 2));
  } else {
    for (const result of results) {
      printResult(result);
    }
  }

  const failures = collectResultFailures(results);
  if (failures.length > 0) {
    printBenchmarkFailures(failures);
    process.exitCode = 1;
  }
}

export const testing = {
  collectResultFailures,
  collectStartupTrace,
  listIncidentPackagedPluginArtifacts,
  parseOptions,
  sanitizedEnv,
  summarizeCase,
  waitForStartupTracePhase,
  withGatewayBenchRoot,
  writeIncidentFixture,
  writeConfig,
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err: unknown) => {
    if (err instanceof CliArgumentError) {
      console.error(err.message);
      process.exitCode = 1;
      return;
    }
    console.error(err instanceof Error ? err.stack : String(err));
    process.exitCode = 1;
  });
}
