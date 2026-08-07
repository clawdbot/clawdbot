import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const [databasePath, pidFile] = process.argv.slice(2);

function readProcess(pid) {
  if (!/^\d+$/u.test(pid)) {
    return undefined;
  }
  try {
    const envKeys = fs
      .readFileSync(`/proc/${pid}/environ`, "utf8")
      .split("\0")
      .map((entry) => entry.slice(0, entry.indexOf("=")))
      .filter(Boolean);
    const children = fs
      .readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8")
      .trim()
      .split(/\s+/u)
      .filter(Boolean);
    return {
      pid: Number(pid),
      updateEnvKeys: envKeys.filter((key) => key.startsWith("OPENCLAW_UPDATE_")).toSorted(),
      compatibilityHostVersionPresent: envKeys.includes("OPENCLAW_COMPATIBILITY_HOST_VERSION"),
      registryPresent:
        envKeys.includes("NPM_CONFIG_REGISTRY") || envKeys.includes("npm_config_registry"),
      children,
    };
  } catch (error) {
    return { pid: Number(pid), error: String(error) };
  }
}

const result = {
  database: undefined,
  supervisor: undefined,
  children: [],
};

try {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  const row = database
    .prepare(
      `SELECT host_contract_version, install_records_json, plugins_json
         FROM installed_plugin_index
        WHERE index_key = ?`,
    )
    .get("installed-plugin-index");
  database.close();
  const installRecords = row ? JSON.parse(row.install_records_json) : {};
  const plugins = row ? JSON.parse(row.plugins_json) : [];
  const record = installRecords.codex;
  const plugin = plugins.find((entry) => entry?.pluginId === "codex");
  let payloadVersion;
  if (typeof record?.installPath === "string") {
    try {
      payloadVersion = JSON.parse(
        fs.readFileSync(path.join(record.installPath, "package.json"), "utf8"),
      ).version;
    } catch {
      payloadVersion = "unreadable";
    }
  }
  result.database = {
    hostContractVersion: row?.host_contract_version,
    record: record
      ? {
          source: record.source,
          version: record.version,
          resolvedVersion: record.resolvedVersion,
        }
      : undefined,
    pluginPackageVersion: plugin?.packageVersion,
    payloadVersion,
  };
} catch (error) {
  result.database = { error: String(error) };
}

try {
  const supervisorPid = fs.readFileSync(pidFile, "utf8").trim();
  result.supervisor = readProcess(supervisorPid);
  result.children = (result.supervisor?.children ?? [])
    .map(readProcess)
    .filter((entry) => entry !== undefined);
} catch (error) {
  result.supervisor = { error: String(error) };
}

process.stderr.write(
  `--- upgrade survivor plugin state diagnostic ---\n${JSON.stringify(result, null, 2)}\n`,
);
