import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const normalizePathForProbe = (value) => String(value ?? "").replace(/\\/g, "/");
const bundledRuntimeFragments = (pluginDir) => [
  `/dist/extensions/${pluginDir}`,
  `/dist-runtime/extensions/${pluginDir}`,
];
const bundledRuntimeRootFragments = ["/dist/extensions/", "/dist-runtime/extensions/"];
const DEFAULT_PLUGIN_LIST_TIMEOUT_MS = 30_000;
const DEFAULT_PLUGIN_LIST_MAX_BUFFER_BYTES = 4 * 1024 * 1024;

function readIntegerEnv(name, fallback, minimum) {
  const raw = process.env[name];
  if (raw == null || raw === "") {
    return fallback;
  }
  const text = raw.trim();
  if (!/^\d+$/u.test(text)) {
    throw new Error(`invalid ${name}: ${text}`);
  }
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`invalid ${name}: ${text}`);
  }
  return value;
}

function readPositiveIntEnv(name, fallback) {
  return readIntegerEnv(name, fallback, 1);
}

function readNonNegativeIntEnv(name, fallback) {
  return readIntegerEnv(name, fallback, 0);
}

function resolveStateDir() {
  if (process.env.OPENCLAW_STATE_DIR) {
    return process.env.OPENCLAW_STATE_DIR;
  }
  return path.join(process.env.HOME || os.homedir(), ".openclaw");
}

function pathReferencesBundledRuntime(value, pluginDir) {
  const normalized = normalizePathForProbe(value);
  return bundledRuntimeFragments(pluginDir).some((fragment) => normalized.includes(fragment));
}

function pathReferencesPackagedBundledRoot(value) {
  const normalized = normalizePathForProbe(value);
  return bundledRuntimeRootFragments.some((fragment) => normalized.includes(fragment));
}

function resolveOpenClawEntry() {
  if (process.env.OPENCLAW_ENTRY) {
    return process.env.OPENCLAW_ENTRY;
  }
  for (const entry of ["dist/index.mjs", "dist/index.js"]) {
    if (fs.existsSync(entry)) {
      return entry;
    }
  }
  throw new Error("Missing OPENCLAW_ENTRY and dist/index.(m)js");
}

function readPluginsList() {
  const entry = resolveOpenClawEntry();
  const timeoutMs = readPositiveIntEnv(
    "OPENCLAW_BUNDLED_PLUGIN_LIST_TIMEOUT_MS",
    DEFAULT_PLUGIN_LIST_TIMEOUT_MS,
  );
  const result = spawnSync(process.execPath, [entry, "plugins", "list", "--json"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: process.env,
    maxBuffer: readPositiveIntEnv(
      "OPENCLAW_BUNDLED_PLUGIN_LIST_MAX_BUFFER_BYTES",
      DEFAULT_PLUGIN_LIST_MAX_BUFFER_BYTES,
    ),
    killSignal: "SIGKILL",
    timeout: timeoutMs,
  });
  if (result.error) {
    const timedOut = result.error.code === "ETIMEDOUT";
    throw new Error(
      timedOut
        ? `Timed out listing packaged bundled plugins after ${timeoutMs}ms`
        : `Unable to list packaged bundled plugins: ${result.error.message}`,
    );
  }
  if (result.status !== 0) {
    throw new Error(
      `Unable to list packaged bundled plugins: ${result.stderr || result.stdout || `exit ${result.status}`}`,
    );
  }
  const payload = JSON.parse(result.stdout);
  return Array.isArray(payload.plugins) ? payload.plugins : [];
}

function pluginRequiresConfig(pluginDir) {
  const manifestPath = path.join(pluginDir, "openclaw.plugin.json");
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`missing bundled plugin manifest: ${manifestPath}`);
  }
  const manifest = readJson(manifestPath);
  const required = manifest.configSchema?.required;
  return Array.isArray(required) && required.some((value) => typeof value === "string");
}

async function loadPackagedBundledEntries() {
  return readPluginsList()
    .filter((plugin) => plugin?.origin === "bundled")
    .map((plugin) => {
      const id = typeof plugin.id === "string" ? plugin.id.trim() : "";
      const rootDir = typeof plugin.rootDir === "string" ? plugin.rootDir.trim() : "";
      const source = typeof plugin.source === "string" ? plugin.source.trim() : "";
      const pluginDir = rootDir || (source ? path.dirname(source) : "");
      if (!id || !pluginDir || !pathReferencesPackagedBundledRoot(pluginDir)) {
        return null;
      }
      return {
        id,
        dir: path.basename(pluginDir),
        rootDir: pluginDir,
        requiresConfig: pluginRequiresConfig(pluginDir),
      };
    })
    .filter(Boolean)
    .toSorted((a, b) => a.id.localeCompare(b.id));
}

async function loadManifestEntries() {
  const explicit = (process.env.OPENCLAW_BUNDLED_PLUGIN_SWEEP_IDS || "")
    .split(/[,\s]+/u)
    .map((entry) => entry.trim())
    .filter(Boolean);
  const manifestEntries = await loadPackagedBundledEntries();

  if (explicit.length === 0) {
    return manifestEntries;
  }
  const available = manifestEntries.map((entry) => entry.id).join(", ");
  return explicit.map((lookup) => {
    const found = manifestEntries.find((entry) => entry.id === lookup || entry.dir === lookup);
    if (!found) {
      throw new Error(
        `OPENCLAW_BUNDLED_PLUGIN_SWEEP_IDS entry is not an installable bundled plugin in this package: ${lookup}. Available: ${available}`,
      );
    }
    return found;
  });
}

async function selectedManifestEntries() {
  const allEntries = await loadManifestEntries();
  const total = readPositiveIntEnv("OPENCLAW_BUNDLED_PLUGIN_SWEEP_TOTAL", 1);
  const index = readNonNegativeIntEnv("OPENCLAW_BUNDLED_PLUGIN_SWEEP_INDEX", 0);
  if (index >= total) {
    throw new Error(
      `OPENCLAW_BUNDLED_PLUGIN_SWEEP_INDEX must be in [0, ${total - 1}], got ${process.env.OPENCLAW_BUNDLED_PLUGIN_SWEEP_INDEX}`,
    );
  }

  const selected = allEntries.filter((_, candidateIndex) => candidateIndex % total === index);
  if (selected.length === 0) {
    throw new Error(`No bundled plugin ids selected for shard ${index}/${total}`);
  }
  return selected;
}

function assertInstalled(pluginId, pluginDir, requiresConfig) {
  const stateDir = resolveStateDir();
  const configPath = path.join(stateDir, "openclaw.json");
  const indexPath = path.join(stateDir, "plugins", "installs.json");
  const config = readJson(configPath);
  const index = readJson(indexPath);
  const records = index.installRecords ?? index.records ?? {};
  const record = records[pluginId];
  if (!record) {
    throw new Error(`missing install record for ${pluginId}`);
  }
  if (record.source !== "path") {
    throw new Error(
      `expected bundled install record source=path for ${pluginId}, got ${record.source}`,
    );
  }
  if (
    typeof record.sourcePath !== "string" ||
    !pathReferencesBundledRuntime(record.sourcePath, pluginDir)
  ) {
    throw new Error(`unexpected bundled source path for ${pluginId}: ${record.sourcePath}`);
  }
  if (normalizePathForProbe(record.installPath) !== normalizePathForProbe(record.sourcePath)) {
    throw new Error(`bundled install path should equal source path for ${pluginId}`);
  }
  const paths = config.plugins?.load?.paths || [];
  if (paths.some((entry) => pathReferencesBundledRuntime(entry, pluginDir))) {
    throw new Error(`config load paths should not include bundled install path for ${pluginId}`);
  }
  if (requiresConfig && config.plugins?.entries?.[pluginId]?.enabled === true) {
    throw new Error(
      `plugin requiring config should not be enabled immediately after install for ${pluginId}`,
    );
  }
  if (!requiresConfig && config.plugins?.entries?.[pluginId]?.enabled !== true) {
    throw new Error(`config entry is not enabled after install for ${pluginId}`);
  }
  const allow = config.plugins?.allow || [];
  if (Array.isArray(allow) && allow.length > 0 && !allow.includes(pluginId)) {
    throw new Error(`existing allowlist does not include ${pluginId} after install`);
  }
  if ((config.plugins?.deny || []).includes(pluginId)) {
    throw new Error(`denylist contains ${pluginId} after install`);
  }
}

function assertUninstalled(pluginId, pluginDir) {
  const stateDir = resolveStateDir();
  const configPath = path.join(stateDir, "openclaw.json");
  const indexPath = path.join(stateDir, "plugins", "installs.json");
  const config = fs.existsSync(configPath) ? readJson(configPath) : {};
  const index = fs.existsSync(indexPath) ? readJson(indexPath) : {};
  const records = index.installRecords ?? index.records ?? {};
  if (records[pluginId]) {
    throw new Error(`install record still present after uninstall for ${pluginId}`);
  }
  const paths = config.plugins?.load?.paths || [];
  if (paths.some((entry) => pathReferencesBundledRuntime(entry, pluginDir))) {
    throw new Error(`load path still present after uninstall for ${pluginId}`);
  }
  if (config.plugins?.entries?.[pluginId]) {
    throw new Error(`config entry still present after uninstall for ${pluginId}`);
  }
  if ((config.plugins?.allow || []).includes(pluginId)) {
    throw new Error(`allowlist still contains ${pluginId} after uninstall`);
  }
  if ((config.plugins?.deny || []).includes(pluginId)) {
    throw new Error(`denylist still contains ${pluginId} after uninstall`);
  }
  const managedPath = path.join(stateDir, "extensions", pluginId);
  if (fs.existsSync(managedPath)) {
    throw new Error(
      `managed install directory unexpectedly exists for bundled plugin ${pluginId}: ${managedPath}`,
    );
  }
}

const [command, pluginId, pluginDir, requiresConfig] = process.argv.slice(2);
if (command === "select") {
  for (const entry of await selectedManifestEntries()) {
    console.log(`${entry.id}\t${entry.dir}\t${entry.requiresConfig ? "1" : "0"}\t${entry.rootDir}`);
  }
} else if (command === "assert-installed") {
  assertInstalled(pluginId, pluginDir, requiresConfig === "1");
} else if (command === "assert-uninstalled") {
  assertUninstalled(pluginId, pluginDir);
} else {
  throw new Error(`Unknown bundled plugin probe command: ${command || "(missing)"}`);
}
