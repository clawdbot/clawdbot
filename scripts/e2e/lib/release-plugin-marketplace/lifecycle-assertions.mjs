import fs from "node:fs";
import path from "node:path";
import { readPluginInstallIndex } from "../plugin-index-sqlite.mjs";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function stateDir() {
  return process.env.OPENCLAW_STATE_DIR || path.join(process.env.HOME ?? "", ".openclaw");
}

function configPath() {
  return process.env.OPENCLAW_CONFIG_PATH || path.join(stateDir(), "openclaw.json");
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function resolveRecordedPath(value) {
  if (value === "~") {
    return process.env.HOME ?? "";
  }
  if (value.startsWith("~/")) {
    return path.join(process.env.HOME ?? "", value.slice(2));
  }
  return path.resolve(value);
}

function assertPathInside(parent, child, label) {
  const relative = path.relative(fs.realpathSync(parent), fs.realpathSync(child));
  assert(
    relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative),
    `${label} escaped ${parent}: ${child}`,
  );
}

function assertMarketplaceState() {
  const pluginId = process.argv[3];
  const expectedVersion = process.argv[4];
  const expectedMarketplaceSource = process.argv[5];
  const expectedMarketplacePlugin = process.argv[6];
  const installPathFile = process.argv[7];
  assert(pluginId, "missing plugin id");
  assert(expectedVersion, "missing expected version");
  assert(expectedMarketplaceSource, "missing expected marketplace source");
  assert(expectedMarketplacePlugin, "missing expected marketplace plugin");
  assert(installPathFile, "missing install path file");

  const databasePath = path.join(stateDir(), "state", "openclaw.sqlite");
  assert(fs.existsSync(databasePath), `canonical plugin index database missing: ${databasePath}`);
  const index = readPluginInstallIndex({ stateDir: stateDir(), configPath: configPath() });
  const record = index.installRecords?.[pluginId];
  assert(record, `missing install record for ${pluginId}`);
  assert(record.source === "marketplace", `expected marketplace source, got ${record.source}`);
  assert(
    record.marketplaceSource === expectedMarketplaceSource,
    `expected marketplace source ${expectedMarketplaceSource}, got ${record.marketplaceSource}`,
  );
  assert(
    record.marketplacePlugin === expectedMarketplacePlugin,
    `expected marketplace plugin ${expectedMarketplacePlugin}, got ${record.marketplacePlugin}`,
  );
  assert(
    record.version === expectedVersion,
    `expected install record version ${expectedVersion}, got ${record.version}`,
  );

  const indexedPlugin = (index.plugins ?? []).find((entry) => entry.pluginId === pluginId);
  assert(indexedPlugin, `installed plugin index omitted ${pluginId}`);
  assert(
    indexedPlugin.packageVersion === expectedVersion,
    `expected indexed package version ${expectedVersion}, got ${indexedPlugin.packageVersion}`,
  );

  const config = readJson(configPath());
  assert(
    config.plugins?.entries?.[pluginId]?.enabled === true,
    `plugin config entry is not enabled for ${pluginId}`,
  );

  assert(record.installPath, `install path missing for ${pluginId}`);
  const installPath = resolveRecordedPath(record.installPath);
  assert(
    fs.existsSync(installPath),
    `managed install path missing for ${pluginId}: ${installPath}`,
  );
  assertPathInside(path.join(stateDir(), "extensions"), installPath, "managed install path");
  const packageJson = readJson(path.join(installPath, "package.json"));
  assert(
    packageJson.version === expectedVersion,
    `expected installed package version ${expectedVersion}, got ${packageJson.version}`,
  );

  if (fs.existsSync(installPathFile)) {
    const previousInstallPath = fs.readFileSync(installPathFile, "utf8").trim();
    assert(
      previousInstallPath === installPath,
      `plugin update moved the managed install path: ${previousInstallPath} -> ${installPath}`,
    );
  } else {
    fs.writeFileSync(installPathFile, `${installPath}\n`, "utf8");
  }
}

function assertUpdateLog() {
  const logPath = process.argv[3];
  const expected = process.argv[4];
  assert(logPath, "missing update log path");
  assert(expected, "missing expected update log text");
  const output = fs.readFileSync(logPath, "utf8");
  assert(output.includes(expected), `${logPath} did not contain ${expected}`);
}

const commands = {
  "assert-marketplace-state": assertMarketplaceState,
  "assert-update-log": assertUpdateLog,
};

const command = process.argv[2];
const fn = commands[command];
if (!fn) {
  throw new Error(`unknown marketplace lifecycle assertion command: ${command ?? "<missing>"}`);
}
fn();
