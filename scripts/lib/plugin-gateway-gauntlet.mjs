import fs from "node:fs";
import path from "node:path";
import JSON5 from "json5";
import { collectBundledPluginBuildEntries } from "./bundled-plugin-build-entries.mjs";

const MANIFEST_NAMES = ["openclaw.plugin.json", "openclaw.plugin.json5"];

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeStringArray(value) {
  return Array.isArray(value)
    ? value.map((entry) => normalizeString(entry)).filter((entry) => entry.length > 0)
    : [];
}

function readPluginManifest(manifestPath) {
  const raw = fs.readFileSync(manifestPath, "utf8");
  const parsed = manifestPath.endsWith(".json5") ? JSON5.parse(raw) : JSON.parse(raw);
  if (!isPlainObject(parsed)) {
    throw new Error(`Plugin manifest must be an object: ${manifestPath}`);
  }
  const id = normalizeString(parsed.id);
  if (!id) {
    throw new Error(`Plugin manifest is missing id: ${manifestPath}`);
  }
  return parsed;
}

function schemaHasRequiredFields(schema, seen = new Set()) {
  if (!isPlainObject(schema) || seen.has(schema)) {
    return false;
  }
  seen.add(schema);
  if (Array.isArray(schema.required) && schema.required.length > 0) {
    return true;
  }
  for (const key of ["properties", "patternProperties", "$defs", "definitions"]) {
    const children = schema[key];
    if (!isPlainObject(children)) {
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

function collectCommandAliasRecords(manifest) {
  const aliases = Array.isArray(manifest.commandAliases) ? manifest.commandAliases : [];
  return aliases
    .map((alias) => {
      if (typeof alias === "string") {
        const name = normalizeString(alias);
        return name ? { name, kind: "runtime-slash", cliCommand: null } : null;
      }
      if (!isPlainObject(alias)) {
        return null;
      }
      const name = normalizeString(alias.name);
      if (!name) {
        return null;
      }
      return {
        name,
        kind: normalizeString(alias.kind) || "runtime-slash",
        cliCommand: normalizeString(alias.cliCommand) || null,
      };
    })
    .filter(Boolean);
}

function collectAuthMethods(manifest) {
  const auth = Array.isArray(manifest.auth) ? manifest.auth : [];
  return auth
    .map((entry) => (isPlainObject(entry) ? normalizeString(entry.method) : ""))
    .filter((method) => method.length > 0);
}

function collectOnboardingScopes(manifest) {
  const scopes = new Set();
  const addScopes = (value) => {
    for (const scope of normalizeStringArray(value)) {
      scopes.add(scope);
    }
  };
  addScopes(manifest.onboardingScopes);
  if (Array.isArray(manifest.auth)) {
    for (const entry of manifest.auth) {
      if (isPlainObject(entry)) {
        addScopes(entry.onboardingScopes);
      }
    }
  }
  return [...scopes];
}

function buildPluginMatrixEntry(params) {
  const { repoRoot, manifestPath, manifest } = params;
  const relativeManifestPath = path.relative(repoRoot, manifestPath);
  const commandAliases = collectCommandAliasRecords(manifest);
  return {
    id: manifest.id,
    name: normalizeString(manifest.name) || manifest.id,
    dir: path.relative(repoRoot, path.dirname(manifestPath)),
    manifestPath: relativeManifestPath,
    enabledByDefault: manifest.enabledByDefault === true,
    activation: isPlainObject(manifest.activation) ? manifest.activation : {},
    providers: normalizeStringArray(manifest.providers),
    channels: normalizeStringArray(manifest.channels),
    skills: normalizeStringArray(manifest.skills),
    authMethods: collectAuthMethods(manifest),
    onboardingScopes: collectOnboardingScopes(manifest),
    hasConfigSchema: isPlainObject(manifest.configSchema),
    hasRequiredConfigFields: schemaHasRequiredFields(manifest.configSchema),
    commandAliases,
    cliCommandAliases: commandAliases.filter((alias) => alias.cliCommand),
    runtimeSlashAliases: commandAliases.filter((alias) => alias.kind === "runtime-slash"),
  };
}

function discoverBundledPluginManifests(repoRoot) {
  const extensionsDir = path.join(repoRoot, "extensions");
  const buildEntryDirs = new Set(
    collectBundledPluginBuildEntries({ cwd: repoRoot }).map((entry) => entry.id),
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
      const manifestPath = path.join(pluginDir, manifestName);
      const manifest = readPluginManifest(manifestPath);
      return [buildPluginMatrixEntry({ repoRoot, manifestPath, manifest })];
    });
  return entries.toSorted((left, right) => left.id.localeCompare(right.id));
}

function selectPluginEntries(entries, options = {}) {
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

function median(values) {
  const sorted = values
    .filter((value) => typeof value === "number" && Number.isFinite(value))
    .toSorted((left, right) => left - right);
  if (sorted.length === 0) {
    return null;
  }
  const midpoint = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[midpoint] : (sorted[midpoint - 1] + sorted[midpoint]) / 2;
}

function groupByPhase(rows) {
  const phases = new Map();
  for (const row of rows) {
    const phase = normalizeString(row.phase) || "unknown";
    const current = phases.get(phase) ?? [];
    current.push(row);
    phases.set(phase, current);
  }
  return phases;
}

function collectMetricObservations(rows, thresholds = {}) {
  const cpuCoreWarn = thresholds.cpuCoreWarn ?? 0.9;
  const hotWallWarnMs = thresholds.hotWallWarnMs ?? 30_000;
  const wallAnomalyMultiplier = thresholds.wallAnomalyMultiplier ?? 3;
  const maxRssWarnMb = thresholds.maxRssWarnMb ?? null;
  const rssAnomalyMultiplier = thresholds.rssAnomalyMultiplier ?? 2.5;
  const observations = [];
  for (const [phase, phaseRows] of groupByPhase(rows)) {
    const wallMedianMs = median(phaseRows.map((row) => row.wallMs));
    const rssMedianMb = median(phaseRows.map((row) => row.maxRssMb));
    for (const row of phaseRows) {
      const cpuCoreRatio =
        phase === "qa:rpc" && typeof row.qaMetrics?.gatewayCpuCoreRatio === "number"
          ? row.qaMetrics.gatewayCpuCoreRatio
          : row.cpuCoreRatio;
      const wallMs =
        phase === "qa:rpc" && typeof row.qaMetrics?.wallMs === "number"
          ? row.qaMetrics.wallMs
          : row.wallMs;
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
        });
      }
    }
  }
  return observations;
}

function collectQaBaselineRegressionObservations(rows, thresholds = {}) {
  const baselinePluginId = thresholds.baselinePluginId ?? "<baseline>";
  const cpuRegressionMultiplier = thresholds.cpuRegressionMultiplier ?? 2;
  const wallRegressionMultiplier = thresholds.wallRegressionMultiplier ?? 2;
  const baseline = rows.find((row) => row.phase === "qa:rpc" && row.pluginId === baselinePluginId);
  const baselineMetrics = baseline?.qaMetrics;
  if (!baselineMetrics) {
    return [];
  }
  const observations = [];
  for (const row of rows) {
    if (row.phase !== "qa:rpc" || row.pluginId === baselinePluginId || !row.qaMetrics) {
      continue;
    }
    if (
      typeof baselineMetrics.gatewayCpuCoreRatio === "number" &&
      baselineMetrics.gatewayCpuCoreRatio > 0 &&
      typeof row.qaMetrics.gatewayCpuCoreRatio === "number" &&
      row.qaMetrics.gatewayCpuCoreRatio >=
        baselineMetrics.gatewayCpuCoreRatio * cpuRegressionMultiplier
    ) {
      observations.push({
        kind: "qa-baseline-cpu-regression",
        pluginId: row.pluginId ?? null,
        cpuCoreRatio: row.qaMetrics.gatewayCpuCoreRatio,
        baselineCpuCoreRatio: baselineMetrics.gatewayCpuCoreRatio,
        multiplier: cpuRegressionMultiplier,
      });
    }
    if (
      typeof baselineMetrics.wallMs === "number" &&
      baselineMetrics.wallMs > 0 &&
      typeof row.qaMetrics.wallMs === "number" &&
      row.qaMetrics.wallMs >= baselineMetrics.wallMs * wallRegressionMultiplier
    ) {
      observations.push({
        kind: "qa-baseline-wall-regression",
        pluginId: row.pluginId ?? null,
        wallMs: row.qaMetrics.wallMs,
        baselineWallMs: baselineMetrics.wallMs,
        multiplier: wallRegressionMultiplier,
      });
    }
  }
  return observations;
}

function buildGauntletPrebuildEnv(env, options = {}) {
  if (!options.includePrivateQa) {
    return env;
  }
  return {
    ...env,
    OPENCLAW_BUILD_PRIVATE_QA: "1",
    OPENCLAW_ENABLE_PRIVATE_QA_CLI: "1",
  };
}

function collectGatewayCpuObservations(params) {
  const observations = [];
  for (const result of params.startup?.results ?? []) {
    const cpuCoreMax = result.summary?.cpuCoreRatio?.max;
    const wallMax = result.summary?.readyzMs?.max ?? result.summary?.healthzMs?.max;
    if (
      typeof cpuCoreMax === "number" &&
      typeof wallMax === "number" &&
      cpuCoreMax >= params.cpuCoreWarn &&
      wallMax >= params.hotWallWarnMs
    ) {
      observations.push({
        kind: "startup-cpu-hot",
        id: result.id,
        cpuCoreRatioMax: cpuCoreMax,
        wallMsMax: wallMax,
      });
    }
  }
  const qaCpuCoreRatio = params.qa?.metrics?.gatewayCpuCoreRatio;
  const qaWallMs = params.qa?.metrics?.wallMs;
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

export {
  collectQaBaselineRegressionObservations,
  collectGatewayCpuObservations,
  collectMetricObservations,
  buildGauntletPrebuildEnv,
  discoverBundledPluginManifests,
  schemaHasRequiredFields,
  selectPluginEntries,
};
