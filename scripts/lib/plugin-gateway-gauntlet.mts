// Collects plugin manifest and metric observations for gateway gauntlet reports.
import fs from "node:fs";
import path from "node:path";
import JSON5 from "json5";
import {
  NON_PACKAGED_BUNDLED_PLUGIN_DIRS,
  collectBundledPluginBuildEntries,
} from "./bundled-plugin-build-entries.mjs";
import { parsePositiveInt } from "./numeric-options.mjs";
import { isRecord } from "./record-shared.mjs";

type PluginGatewayEntry = {
  id: string;
  requiredPlugins?: string[];
};
type JsonRecord = Record<string, unknown>;
type MetricThresholds = {
  cpuCoreWarn?: number;
  hotWallWarnMs?: number;
  wallAnomalyMultiplier?: number;
  maxRssWarnMb?: number | null;
  rssAnomalyMultiplier?: number;
};
type QaThresholds = {
  baselinePluginId?: string;
  cpuRegressionMultiplier?: number;
  wallRegressionMultiplier?: number;
};
const MANIFEST_NAMES = ["openclaw.plugin.json", "openclaw.plugin.json5"];
const ANSI_PATTERN = new RegExp(String.raw`\u001B\[[0-9;]*m`, "gu");
const QA_SUMMARY_MAX_BYTES_ENV = "OPENCLAW_PLUGIN_GATEWAY_GAUNTLET_QA_SUMMARY_MAX_BYTES";
const DEFAULT_QA_SUMMARY_MAX_BYTES = 2 * 1024 * 1024;

function normalizeStringOrEmpty(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeStringArray(value: unknown) {
  return Array.isArray(value)
    ? value.map((entry) => normalizeStringOrEmpty(entry)).filter((entry) => entry.length > 0)
    : [];
}

function readPluginManifest(manifestPath: string) {
  const raw = fs.readFileSync(manifestPath, "utf8");
  const parsed: unknown = manifestPath.endsWith(".json5") ? JSON5.parse(raw) : JSON.parse(raw);
  if (!isRecord(parsed)) {
    throw new Error(`Plugin manifest must be an object: ${manifestPath}`);
  }
  const id = parsed.id;
  if (typeof id !== "string" || id.trim().length === 0) {
    throw new Error(`Plugin manifest is missing id: ${manifestPath}`);
  }
  return Object.assign({}, parsed, { id });
}

type PluginManifest = ReturnType<typeof readPluginManifest>;

function schemaHasRequiredFields(schema: unknown, seen = new Set<JsonRecord>()) {
  if (!isRecord(schema) || seen.has(schema)) {
    return false;
  }
  seen.add(schema);
  if (Array.isArray(schema.required) && schema.required.length > 0) {
    return true;
  }
  for (const key of ["properties", "patternProperties", "$defs", "definitions"]) {
    const children = schema[key];
    if (!isRecord(children)) {
      continue;
    }
    for (const child of Object.values(children)) {
      if (schemaHasRequiredFields(child, seen)) {
        return true;
      }
    }
  }
  for (const key of ["items", "additionalProperties", "contains", "not", "if", "then", "else"]) {
    if (schemaHasRequiredFields(schema[key], seen)) {
      return true;
    }
  }
  for (const key of ["allOf", "anyOf", "oneOf", "prefixItems"]) {
    const children = schema[key];
    if (!Array.isArray(children)) {
      continue;
    }
    if (children.some((child) => schemaHasRequiredFields(child, seen))) {
      return true;
    }
  }
  return false;
}

function collectCommandAliasRecords(manifest: PluginManifest) {
  const aliases = Array.isArray(manifest.commandAliases) ? manifest.commandAliases : [];
  return aliases
    .map((alias) => {
      if (typeof alias === "string") {
        const name = normalizeStringOrEmpty(alias);
        return name ? { name, kind: "runtime-slash", cliCommand: null } : null;
      }
      if (!isRecord(alias)) {
        return null;
      }
      const name = normalizeStringOrEmpty(alias.name);
      if (!name) {
        return null;
      }
      return {
        name,
        kind: normalizeStringOrEmpty(alias.kind) || "runtime-slash",
        cliCommand: normalizeStringOrEmpty(alias.cliCommand) || null,
      };
    })
    .filter((alias) => alias !== null);
}

function collectAuthMethods(manifest: PluginManifest) {
  const auth = Array.isArray(manifest.auth) ? manifest.auth : [];
  return auth
    .map((entry) => (isRecord(entry) ? normalizeStringOrEmpty(entry.method) : ""))
    .filter((method) => method.length > 0);
}

function collectOnboardingScopes(manifest: PluginManifest) {
  const scopes = new Set<string>();
  const addScopes = (value: unknown) => {
    for (const scope of normalizeStringArray(value)) {
      scopes.add(scope);
    }
  };
  addScopes(manifest.onboardingScopes);
  if (Array.isArray(manifest.auth)) {
    for (const entry of manifest.auth) {
      if (isRecord(entry)) {
        addScopes(entry.onboardingScopes);
      }
    }
  }
  return [...scopes];
}

function buildPluginMatrixEntry(repoRoot: string, manifestPath: string, manifest: PluginManifest) {
  const pluginDir = path.dirname(manifestPath);
  const relativeManifestPath = path.relative(repoRoot, manifestPath);
  const commandAliases = collectCommandAliasRecords(manifest);
  return {
    id: manifest.id,
    buildId: path.basename(pluginDir),
    name: normalizeStringOrEmpty(manifest.name) || manifest.id,
    dir: path.relative(repoRoot, pluginDir),
    manifestPath: relativeManifestPath,
    enabledByDefault: manifest.enabledByDefault === true,
    activation: isRecord(manifest.activation) ? manifest.activation : {},
    providers: normalizeStringArray(manifest.providers),
    channels: normalizeStringArray(manifest.channels),
    skills: normalizeStringArray(manifest.skills),
    authMethods: collectAuthMethods(manifest),
    onboardingScopes: collectOnboardingScopes(manifest),
    requiredPlugins: normalizeStringArray(manifest.requiresPlugins),
    hasConfigSchema: isRecord(manifest.configSchema),
    hasRequiredConfigFields: schemaHasRequiredFields(manifest.configSchema),
    commandAliases,
    cliCommandAliases: commandAliases.filter((alias) => alias.cliCommand),
    runtimeSlashAliases: commandAliases.filter((alias) => alias.kind === "runtime-slash"),
  };
}

function discoverBundledPluginManifests(repoRoot: string) {
  const extensionsDir = path.join(repoRoot, "extensions");
  const buildEntryDirs = new Set(
    collectBundledPluginBuildEntries({ cwd: repoRoot }).map((entry: { id: string }) => entry.id),
  );
  const entries = fs
    .readdirSync(extensionsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .filter((entry) => buildEntryDirs.has(entry.name))
    .flatMap((entry) => {
      const pluginDir = path.join(extensionsDir, entry.name);
      const manifestName = MANIFEST_NAMES.find((name) => fs.existsSync(path.join(pluginDir, name)));
      if (!manifestName) {
        return [];
      }
      if (NON_PACKAGED_BUNDLED_PLUGIN_DIRS.has(entry.name)) {
        return [];
      }
      const manifestPath = path.join(pluginDir, manifestName);
      const manifest = readPluginManifest(manifestPath);
      return [buildPluginMatrixEntry(repoRoot, manifestPath, manifest)];
    });
  return entries.toSorted((left, right) => left.id.localeCompare(right.id));
}

function selectPluginEntries<T extends PluginGatewayEntry>(
  entries: T[],
  options: { ids?: string[]; shardIndex?: number; shardTotal?: number; limit?: number } = {},
) {
  const ids = new Set(normalizeStringArray(options.ids));
  let selected = ids.size > 0 ? entries.filter((entry) => ids.has(entry.id)) : [...entries];
  const missingIds = [...ids].filter((id) => !entries.some((entry) => entry.id === id));
  if (missingIds.length > 0) {
    throw new Error(`Unknown bundled plugin id(s): ${missingIds.join(", ")}`);
  }
  const shardTotal = options.shardTotal ?? 1;
  const shardIndex = options.shardIndex ?? 0;
  if (!Number.isInteger(shardTotal) || shardTotal < 1) {
    throw new Error("--shard-total must be a positive integer");
  }
  if (!Number.isInteger(shardIndex) || shardIndex < 0 || shardIndex >= shardTotal) {
    throw new Error("--shard-index must be in range [0, shard-total)");
  }
  selected = selected.filter((_, index) => index % shardTotal === shardIndex);
  if (options.limit !== undefined) {
    if (!Number.isInteger(options.limit) || options.limit < 1) {
      throw new Error("--limit must be a positive integer");
    }
    selected = selected.slice(0, options.limit);
  }
  return selected;
}

function collectRequiredPluginEntries<T extends PluginGatewayEntry>(entries: T[], plugins: T[]) {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const selectedIds = new Set(plugins.map((entry) => entry.id));
  const required = new Map<string, T>();
  const visit = (requiredId: string, ownerId: string, trail: string[]) => {
    const entry = byId.get(requiredId);
    if (!entry) {
      throw new Error(
        `Bundled plugin "${ownerId}" requires unknown bundled plugin "${requiredId}"`,
      );
    }
    const cycleIndex = trail.indexOf(requiredId);
    if (cycleIndex !== -1) {
      const cycle = [...trail.slice(cycleIndex), requiredId].join(" -> ");
      throw new Error(`Bundled plugin dependency cycle detected: ${cycle}`);
    }
    if (required.has(requiredId)) {
      return;
    }
    const nextTrail = [...trail, requiredId];
    for (const transitiveRequiredId of entry.requiredPlugins ?? []) {
      visit(transitiveRequiredId, ownerId, nextTrail);
    }
    if (!selectedIds.has(requiredId)) {
      required.set(requiredId, entry);
    }
  };
  for (const plugin of plugins) {
    for (const requiredId of plugin.requiredPlugins ?? []) {
      visit(requiredId, plugin.id, [plugin.id]);
    }
  }
  return [...required.values()];
}

function collectPluginsWithRequiredEntries<T extends PluginGatewayEntry>(
  entries: T[],
  plugins: T[],
) {
  const combined = new Map<string, T>();
  for (const plugin of collectRequiredPluginEntries(entries, plugins)) {
    combined.set(plugin.id, plugin);
  }
  for (const plugin of plugins) {
    combined.set(plugin.id, plugin);
  }
  return [...combined.values()];
}

function median(values: unknown[]) {
  const sorted = values
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value))
    .toSorted((left, right) => left - right);
  if (sorted.length === 0) {
    return null;
  }
  const midpoint = Math.floor(sorted.length / 2);
  const [lower, upper] = sorted.slice(midpoint - 1, midpoint + 1);
  return upper === undefined || lower === undefined || sorted.length % 2 === 1
    ? (upper ?? lower ?? null)
    : (lower + upper) / 2;
}

function groupByPhase(rows: JsonRecord[]) {
  const phases = new Map<string, JsonRecord[]>();
  for (const row of rows) {
    const phase = normalizeStringOrEmpty(row.phase) || "unknown";
    const current = phases.get(phase) ?? [];
    current.push(row);
    phases.set(phase, current);
  }
  return phases;
}

function collectMetricObservations(rows: JsonRecord[], thresholds: MetricThresholds = {}) {
  const cpuCoreWarn = thresholds.cpuCoreWarn ?? 0.9;
  const hotWallWarnMs = thresholds.hotWallWarnMs ?? 30_000;
  const wallAnomalyMultiplier = thresholds.wallAnomalyMultiplier ?? 3;
  const maxRssWarnMb = thresholds.maxRssWarnMb ?? null;
  const rssAnomalyMultiplier = thresholds.rssAnomalyMultiplier ?? 2.5;
  const firstWorkRow = rows.find((row) => row.phase !== "prebuild");
  const observations = [];
  for (const [phase, phaseRows] of groupByPhase(rows)) {
    const wallMedianMs = median(phaseRows.map((row) => row.wallMs));
    const rssMedianMb = median(phaseRows.map((row) => row.maxRssMb));
    for (const row of phaseRows) {
      const coldStart = row === firstWorkRow;
      const qaMetrics = isRecord(row.qaMetrics) ? row.qaMetrics : undefined;
      const cpuCoreRatio =
        phase === "qa:rpc" && typeof qaMetrics?.gatewayCpuCoreRatio === "number"
          ? qaMetrics.gatewayCpuCoreRatio
          : row.cpuCoreRatio;
      const wallMs =
        phase === "qa:rpc" && typeof qaMetrics?.wallMs === "number" ? qaMetrics.wallMs : row.wallMs;
      if (
        typeof cpuCoreRatio === "number" &&
        typeof wallMs === "number" &&
        cpuCoreRatio >= cpuCoreWarn &&
        wallMs >= hotWallWarnMs
      ) {
        observations.push({
          kind: "phase-cpu-hot",
          pluginId: row.pluginId ?? null,
          phase,
          cpuCoreRatio,
          wallMs,
          ...(coldStart ? { coldStart } : {}),
        });
      }
      if (
        wallMedianMs !== null &&
        phaseRows.length >= 3 &&
        typeof row.wallMs === "number" &&
        row.wallMs >= wallMedianMs * wallAnomalyMultiplier
      ) {
        observations.push({
          kind: "phase-wall-anomaly",
          pluginId: row.pluginId ?? null,
          phase,
          wallMs: row.wallMs,
          medianWallMs: wallMedianMs,
          multiplier: wallAnomalyMultiplier,
          ...(coldStart ? { coldStart } : {}),
        });
      }
      if (
        typeof maxRssWarnMb === "number" &&
        typeof row.maxRssMb === "number" &&
        row.maxRssMb >= maxRssWarnMb
      ) {
        observations.push({
          kind: "phase-rss-high",
          pluginId: row.pluginId ?? null,
          phase,
          maxRssMb: row.maxRssMb,
          thresholdMb: maxRssWarnMb,
          ...(coldStart ? { coldStart } : {}),
        });
      }
      if (
        rssMedianMb !== null &&
        rssMedianMb > 0 &&
        phaseRows.length >= 3 &&
        typeof row.maxRssMb === "number" &&
        row.maxRssMb >= rssMedianMb * rssAnomalyMultiplier
      ) {
        observations.push({
          kind: "phase-rss-anomaly",
          pluginId: row.pluginId ?? null,
          phase,
          maxRssMb: row.maxRssMb,
          medianRssMb: rssMedianMb,
          multiplier: rssAnomalyMultiplier,
          ...(coldStart ? { coldStart } : {}),
        });
      }
    }
  }
  return observations;
}

function collectQaBaselineRegressionObservations(
  rows: JsonRecord[],
  thresholds: QaThresholds = {},
) {
  const baselinePluginId = thresholds.baselinePluginId ?? "<baseline>";
  const cpuRegressionMultiplier = thresholds.cpuRegressionMultiplier ?? 2;
  const wallRegressionMultiplier = thresholds.wallRegressionMultiplier ?? 2;
  const baseline = rows.find((row) => row.phase === "qa:rpc" && row.pluginId === baselinePluginId);
  const baselineMetrics = baseline?.qaMetrics;
  if (!isRecord(baselineMetrics)) {
    return [];
  }
  const observations = [];
  for (const row of rows) {
    const qaMetrics = isRecord(row.qaMetrics) ? row.qaMetrics : undefined;
    if (row.phase !== "qa:rpc" || row.pluginId === baselinePluginId || !qaMetrics) {
      continue;
    }
    if (
      typeof baselineMetrics.gatewayCpuCoreRatio === "number" &&
      baselineMetrics.gatewayCpuCoreRatio > 0 &&
      typeof qaMetrics.gatewayCpuCoreRatio === "number" &&
      qaMetrics.gatewayCpuCoreRatio >= baselineMetrics.gatewayCpuCoreRatio * cpuRegressionMultiplier
    ) {
      observations.push({
        kind: "qa-baseline-cpu-regression",
        pluginId: row.pluginId ?? null,
        cpuCoreRatio: qaMetrics.gatewayCpuCoreRatio,
        baselineCpuCoreRatio: baselineMetrics.gatewayCpuCoreRatio,
        multiplier: cpuRegressionMultiplier,
      });
    }
    if (
      typeof baselineMetrics.wallMs === "number" &&
      baselineMetrics.wallMs > 0 &&
      typeof qaMetrics.wallMs === "number" &&
      qaMetrics.wallMs >= baselineMetrics.wallMs * wallRegressionMultiplier
    ) {
      observations.push({
        kind: "qa-baseline-wall-regression",
        pluginId: row.pluginId ?? null,
        wallMs: qaMetrics.wallMs,
        baselineWallMs: baselineMetrics.wallMs,
        multiplier: wallRegressionMultiplier,
      });
    }
  }
  return observations;
}

function buildGauntletPrebuildEnv(
  env: NodeJS.ProcessEnv,
  options: {
    buildIds?: string[];
    skipDeclarationBuild?: boolean;
    includePrivateQa?: boolean;
  } = {},
) {
  const buildIds = new Set(normalizeStringArray(options.buildIds));
  const runtimeOnlyPrebuildEnv = options.skipDeclarationBuild
    ? { OPENCLAW_RUN_NODE_SKIP_DTS_BUILD: "1" }
    : {};
  const hasRuntimeOnlyPrebuildEnv = Object.keys(runtimeOnlyPrebuildEnv).length > 0;
  if (options.includePrivateQa) {
    for (const pluginId of NON_PACKAGED_BUNDLED_PLUGIN_DIRS) {
      buildIds.add(pluginId);
    }
  }
  if (!options.includePrivateQa) {
    return buildIds.size === 0 && !hasRuntimeOnlyPrebuildEnv
      ? env
      : {
          ...env,
          PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN: env.PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN ?? "false",
          ...runtimeOnlyPrebuildEnv,
          ...(buildIds.size > 0
            ? {
                OPENCLAW_BUNDLED_PLUGIN_BUILD_IDS: [...buildIds]
                  .toSorted((left, right) => left.localeCompare(right))
                  .join(","),
              }
            : {}),
        };
  }
  return {
    ...env,
    PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN: env.PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN ?? "false",
    ...runtimeOnlyPrebuildEnv,
    OPENCLAW_BUILD_PRIVATE_QA: "1",
    OPENCLAW_ENABLE_PRIVATE_QA_CLI: "1",
    ...(buildIds.size > 0
      ? {
          OPENCLAW_BUNDLED_PLUGIN_BUILD_IDS: [...buildIds]
            .toSorted((left, right) => left.localeCompare(right))
            .join(","),
        }
      : {}),
  };
}

function detectCommandDiagnosticFailure(stdout: string, stderr: string) {
  const output = `${stdout}\n${stderr}`.replace(ANSI_PATTERN, "");
  if (/^\[plugins\]\s+\S+\s+failed to load from\s+/mu.test(output)) {
    return "plugin-load-failure" satisfies "plugin-load-failure";
  }
  return null;
}

function metricMax(summary: unknown, name: string) {
  if (!isRecord(summary)) {
    return undefined;
  }
  const metric = summary[name];
  return isRecord(metric) ? metric.max : undefined;
}

function collectGatewayCpuObservations(params: {
  startup?: unknown;
  qa?: unknown;
  cpuCoreWarn: number;
  hotWallWarnMs: number;
}) {
  const observations = [];
  const results =
    isRecord(params.startup) && Array.isArray(params.startup.results) ? params.startup.results : [];
  for (const result of results) {
    if (!isRecord(result)) {
      continue;
    }
    const id = normalizeStringOrEmpty(result.id) || "unknown";
    const cpuCoreMax = metricMax(result.summary, "cpuCoreRatio");
    const wallMax = metricMax(result.summary, "readyzMs") ?? metricMax(result.summary, "healthzMs");
    if (
      typeof cpuCoreMax === "number" &&
      typeof wallMax === "number" &&
      cpuCoreMax >= params.cpuCoreWarn &&
      wallMax >= params.hotWallWarnMs
    ) {
      observations.push({
        kind: "startup-cpu-hot",
        id,
        cpuCoreRatioMax: cpuCoreMax,
        wallMsMax: wallMax,
      });
    }
  }
  const qaMetrics = isRecord(params.qa) && isRecord(params.qa.metrics) ? params.qa.metrics : {};
  const qaCpuCoreRatio = qaMetrics.gatewayCpuCoreRatio;
  const qaWallMs = qaMetrics.wallMs;
  if (
    typeof qaCpuCoreRatio === "number" &&
    typeof qaWallMs === "number" &&
    qaCpuCoreRatio >= params.cpuCoreWarn &&
    qaWallMs >= params.hotWallWarnMs
  ) {
    observations.push({
      kind: "qa-cpu-hot",
      id: "qa-suite",
      cpuCoreRatio: qaCpuCoreRatio,
      wallMs: qaWallMs,
    });
  }
  return observations;
}

function readQaSuiteSummary(summaryPath: string) {
  if (!fs.existsSync(summaryPath)) {
    return {
      diagnosticFailure: "qa-summary-missing",
      diagnosticDetail: `expected QA suite summary at ${summaryPath}`,
      summary: null,
    };
  }
  try {
    const summary = validateQaSuiteSummary(JSON.parse(readQaSuiteSummaryText(summaryPath)));
    if (summary.counts.failed > 0) {
      return {
        diagnosticFailure: "qa-summary-failed-scenarios",
        diagnosticDetail: `QA suite reported ${summary.counts.failed} failed scenario(s)`,
        summary,
      };
    }
    return {
      diagnosticFailure: null,
      diagnosticDetail: null,
      summary,
    };
  } catch (error) {
    return {
      diagnosticFailure: "qa-summary-invalid",
      diagnosticDetail: error instanceof Error ? error.message : String(error),
      summary: null,
    };
  }
}

function readQaSuiteSummaryText(summaryPath: string) {
  const maxBytes = parsePositiveInt(
    process.env[QA_SUMMARY_MAX_BYTES_ENV] || String(DEFAULT_QA_SUMMARY_MAX_BYTES),
    QA_SUMMARY_MAX_BYTES_ENV,
  );
  const stat = fs.statSync(summaryPath);
  if (!stat.isFile()) {
    throw new Error(`QA suite summary is not a file: ${summaryPath}`);
  }
  if (stat.size > maxBytes) {
    throw new Error(
      `QA suite summary exceeded ${maxBytes} bytes: ${summaryPath} (${stat.size} bytes)`,
    );
  }
  const text = fs.readFileSync(summaryPath, "utf8");
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > maxBytes) {
    throw new Error(`QA suite summary exceeded ${maxBytes} bytes: ${summaryPath} (${bytes} bytes)`);
  }
  return text;
}

function validateQaSuiteSummary(summary: unknown) {
  if (!isRecord(summary)) {
    throw new Error("QA suite summary must be a JSON object");
  }
  const scenarios = summary.scenarios;
  if (!Array.isArray(scenarios)) {
    throw new Error("QA suite summary missing scenarios array");
  }
  const counts = summary.counts;
  if (
    !isRecord(counts) ||
    !isNonNegativeInteger(counts.total) ||
    !isNonNegativeInteger(counts.passed) ||
    !isNonNegativeInteger(counts.failed)
  ) {
    throw new Error("QA suite summary missing numeric counts");
  }
  if (!isRecord(summary.run)) {
    throw new Error("QA suite summary missing run metadata");
  }
  if (summary.run.status !== "completed") {
    throw new Error(
      `QA suite summary run.status must be completed, got ${String(summary.run.status)}`,
    );
  }
  const statusCounts = { failed: 0, passed: 0, skipped: 0 };
  for (const scenario of scenarios) {
    if (!isRecord(scenario)) {
      throw new Error("QA suite summary scenario entries must be objects");
    }
    if (scenario.status === "pass") {
      statusCounts.passed += 1;
    } else if (scenario.status === "fail") {
      statusCounts.failed += 1;
    } else if (scenario.status === "skip") {
      statusCounts.skipped += 1;
    } else {
      throw new Error(`QA suite summary scenario has invalid status: ${String(scenario.status)}`);
    }
  }
  if (counts.total !== scenarios.length) {
    throw new Error(
      `QA suite summary total count mismatch: counts.total=${counts.total}, scenarios=${scenarios.length}`,
    );
  }
  if (counts.passed !== statusCounts.passed) {
    throw new Error(
      `QA suite summary passed count mismatch: counts.passed=${counts.passed}, passed scenarios=${statusCounts.passed}`,
    );
  }
  if (counts.failed !== statusCounts.failed) {
    throw new Error(
      `QA suite summary failed count mismatch: counts.failed=${counts.failed}, failed scenarios=${statusCounts.failed}`,
    );
  }
  if (
    counts.skipped !== undefined &&
    (!isNonNegativeInteger(counts.skipped) || counts.skipped !== statusCounts.skipped)
  ) {
    throw new Error(
      `QA suite summary skipped count mismatch: counts.skipped=${JSON.stringify(counts.skipped) ?? "undefined"}, skipped scenarios=${statusCounts.skipped}`,
    );
  }
  if (counts.failed === 0) {
    const emptyPassedScenario = scenarios.find(
      (scenario) =>
        isRecord(scenario) &&
        scenario.status === "pass" &&
        (!Array.isArray(scenario.steps) || scenario.steps.length === 0),
    );
    if (emptyPassedScenario) {
      throw new Error(
        `QA suite summary passed scenario has no step evidence: ${String(emptyPassedScenario.name ?? "<unknown>")}`,
      );
    }
  }
  return Object.assign({}, summary, {
    counts: Object.assign({}, counts, { failed: counts.failed }),
  });
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

export {
  collectQaBaselineRegressionObservations,
  collectPluginsWithRequiredEntries,
  collectRequiredPluginEntries,
  collectGatewayCpuObservations,
  collectMetricObservations,
  buildGauntletPrebuildEnv,
  detectCommandDiagnosticFailure,
  discoverBundledPluginManifests,
  readQaSuiteSummary,
  selectPluginEntries,
};
