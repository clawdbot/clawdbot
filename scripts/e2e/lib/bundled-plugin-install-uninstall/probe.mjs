import fs from "node:fs";
import path from "node:path";

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

function loadManifestEntries() {
  const explicit = (process.env.OPENCLAW_BUNDLED_PLUGIN_SWEEP_IDS || "")
    .split(/[,\s]+/u)
    .map((entry) => entry.trim())
    .filter(Boolean);
  const extensionRoot = path.join(process.cwd(), "dist", "extensions");
  const manifestEntries = fs
    .readdirSync(extensionRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const manifestPath = path.join(extensionRoot, entry.name, "openclaw.plugin.json");
      if (!fs.existsSync(manifestPath)) {
        return null;
      }
      const manifest = readJson(manifestPath);
      const id = typeof manifest.id === "string" ? manifest.id.trim() : "";
      if (!id) {
        throw new Error(`Bundled plugin manifest is missing id: ${manifestPath}`);
      }
      const required = manifest.configSchema?.required;
      return {
        id,
        dir: entry.name,
        requiresConfig:
          Array.isArray(required) && required.some((value) => typeof value === "string"),
      };
    })
    .filter(Boolean)
    .toSorted((a, b) => a.id.localeCompare(b.id));

  if (explicit.length === 0) {
    return manifestEntries;
  }
  return explicit.map(
    (lookup) =>
      manifestEntries.find((entry) => entry.id === lookup || entry.dir === lookup) || {
        id: lookup,
        dir: lookup,
        requiresConfig: false,
      },
  );
}

function selectedManifestEntries() {
  const allEntries = loadManifestEntries();
  const total = Number.parseInt(process.env.OPENCLAW_BUNDLED_PLUGIN_SWEEP_TOTAL || "1", 10);
  const index = Number.parseInt(process.env.OPENCLAW_BUNDLED_PLUGIN_SWEEP_INDEX || "0", 10);
  if (!Number.isInteger(total) || total < 1) {
    throw new Error(
      `OPENCLAW_BUNDLED_PLUGIN_SWEEP_TOTAL must be >= 1, got ${process.env.OPENCLAW_BUNDLED_PLUGIN_SWEEP_TOTAL}`,
    );
  }
  if (!Number.isInteger(index) || index < 0 || index >= total) {
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
  const configPath = path.join(process.env.HOME, ".openclaw", "openclaw.json");
  const indexPath = path.join(process.env.HOME, ".openclaw", "plugins", "installs.json");
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
    !record.sourcePath.includes(`/dist/extensions/${pluginDir}`)
  ) {
    throw new Error(`unexpected bundled source path for ${pluginId}: ${record.sourcePath}`);
  }
  if (record.installPath !== record.sourcePath) {
    throw new Error(`bundled install path should equal source path for ${pluginId}`);
  }
  const paths = config.plugins?.load?.paths || [];
  if (paths.some((entry) => String(entry).includes(`/dist/extensions/${pluginDir}`))) {
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
  const configPath = path.join(process.env.HOME, ".openclaw", "openclaw.json");
  const indexPath = path.join(process.env.HOME, ".openclaw", "plugins", "installs.json");
  const config = fs.existsSync(configPath) ? readJson(configPath) : {};
  const index = fs.existsSync(indexPath) ? readJson(indexPath) : {};
  const records = index.installRecords ?? index.records ?? {};
  if (records[pluginId]) {
    throw new Error(`install record still present after uninstall for ${pluginId}`);
  }
  const paths = config.plugins?.load?.paths || [];
  if (paths.some((entry) => String(entry).includes(`/dist/extensions/${pluginDir}`))) {
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
  const managedPath = path.join(process.env.HOME, ".openclaw", "extensions", pluginId);
  if (fs.existsSync(managedPath)) {
    throw new Error(
      `managed install directory unexpectedly exists for bundled plugin ${pluginId}: ${managedPath}`,
    );
  }
}

const [command, pluginId, pluginDir, requiresConfig] = process.argv.slice(2);
if (command === "select") {
  for (const entry of selectedManifestEntries()) {
    console.log(`${entry.id}\t${entry.dir}\t${entry.requiresConfig ? "1" : "0"}`);
  }
} else if (command === "assert-installed") {
  assertInstalled(pluginId, pluginDir, requiresConfig === "1");
} else if (command === "assert-uninstalled") {
  assertUninstalled(pluginId, pluginDir);
} else {
  throw new Error(`Unknown bundled plugin probe command: ${command || "(missing)"}`);
}
