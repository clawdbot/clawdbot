// Probe script for plugin lifecycle matrix E2E scenarios.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readPluginInstallRecords } from "../plugin-index-sqlite.mjs";

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

function readRequiredJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`failed to read JSON from ${file}: ${message}`, { cause: error });
  }
}

function records() {
  return readPluginInstallRecords();
}

function recordFor(pluginId) {
  return records()[pluginId];
}

function config() {
  return readJson(process.env.OPENCLAW_CONFIG_PATH ?? openclawPath("openclaw.json"));
}

function requiredConfig() {
  return readRequiredJson(process.env.OPENCLAW_CONFIG_PATH ?? openclawPath("openclaw.json"));
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

function assertNpmProjectRoot(pluginId, packageName) {
  const record = recordFor(pluginId);
  assert(record?.installPath, `install path missing for ${pluginId}`);
  const relative = path.relative(openclawPath("npm", "projects"), record.installPath);
  assert(
    !relative.startsWith("..") && !path.isAbsolute(relative),
    `install path outside npm projects: ${record.installPath}`,
  );
  const segments = relative.split(path.sep);
  const packageSegments = packageName.split("/");
  assert(
    segments.length === 2 + packageSegments.length,
    `unexpected npm project install path: ${record.installPath}`,
  );
  assert(Boolean(segments[0]), `missing npm project directory: ${record.installPath}`);
  assert(
    segments[1] === "node_modules",
    `missing project node_modules segment: ${record.installPath}`,
  );
  for (let index = 0; index < packageSegments.length; index++) {
    assert(
      segments[index + 2] === packageSegments[index],
      `package path mismatch: ${record.installPath}`,
    );
  }
  assert(
    !fs.existsSync(openclawPath("npm", "node_modules", ...packageSegments)),
    `legacy flat npm install path exists for ${packageName}`,
  );
}

function assertInspectLoaded(pluginId, inspectPath) {
  assert(inspectPath, "inspect JSON path is required");
  const inspect = readRequiredJson(inspectPath);
  const plugin = inspect.plugin;
  assert(plugin?.id === pluginId, `expected inspected plugin id ${pluginId}, got ${plugin?.id}`);
  assert(plugin.enabled === true, `expected ${pluginId} inspect enabled=true`);
  assert(
    plugin.status === "loaded",
    `expected ${pluginId} inspect status loaded, got ${plugin.status}`,
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
  const cfg = requiredConfig();
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
  case "assert-npm-project-root":
    assertNpmProjectRoot(pluginId, arg);
    break;
  case "assert-inspect-loaded":
    assertInspectLoaded(pluginId, arg);
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
