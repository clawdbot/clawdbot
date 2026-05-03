import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = os.homedir();

function openclawPath(...parts) {
  return path.join(home, ".openclaw", ...parts);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

function records() {
  const index = readJson(openclawPath("plugins", "installs.json"));
  return index.installRecords ?? index.records ?? {};
}

function recordFor(pluginId) {
  return records()[pluginId];
}

function config() {
  return readJson(process.env.OPENCLAW_CONFIG_PATH ?? openclawPath("openclaw.json"));
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function assertVersion(pluginId, version) {
  const record = recordFor(pluginId);
  assert(record, `install record missing for ${pluginId}`);
  assert(record.source === "npm", `expected npm source for ${pluginId}, got ${record.source}`);
  assert(
    record.resolvedVersion === version || record.version === version,
    `expected ${pluginId} record version ${version}, got ${JSON.stringify(record)}`,
  );
  assert(record.installPath, `install path missing for ${pluginId}`);
  const packageJson = readJson(path.join(record.installPath, "package.json"));
  assert(
    packageJson.version === version,
    `expected installed package version ${version}, got ${packageJson.version}`,
  );
}

function assertEnabled(pluginId, expectedRaw) {
  const expected = expectedRaw === "true";
  const entry = config().plugins?.entries?.[pluginId];
  assert(entry?.enabled === expected, `expected ${pluginId} enabled=${expected}`);
}

function printInstallPath(pluginId) {
  const record = recordFor(pluginId);
  assert(record?.installPath, `install path missing for ${pluginId}`);
  process.stdout.write(record.installPath);
}

function assertUninstalled(pluginId) {
  const cfg = config();
  const record = recordFor(pluginId);
  assert(!record, `install record still present for ${pluginId}`);
  assert(!cfg.plugins?.entries?.[pluginId], `plugin config entry still present for ${pluginId}`);
  assert(!(cfg.plugins?.allow ?? []).includes(pluginId), `allowlist still contains ${pluginId}`);
  assert(!(cfg.plugins?.deny ?? []).includes(pluginId), `denylist still contains ${pluginId}`);
  const loadPaths = cfg.plugins?.load?.paths ?? [];
  assert(
    !loadPaths.some((entry) => String(entry).includes(pluginId)),
    `load path still references ${pluginId}: ${loadPaths.join(", ")}`,
  );
}

const [command, pluginId, arg] = process.argv.slice(2);
switch (command) {
  case "assert-version":
    assertVersion(pluginId, arg);
    break;
  case "assert-enabled":
    assertEnabled(pluginId, arg);
    break;
  case "install-path":
    printInstallPath(pluginId);
    break;
  case "assert-uninstalled":
    assertUninstalled(pluginId);
    break;
  default:
    throw new Error(`unknown plugin lifecycle matrix probe command: ${command ?? "<missing>"}`);
}
