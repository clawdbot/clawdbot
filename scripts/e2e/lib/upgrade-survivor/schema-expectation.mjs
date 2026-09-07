import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

// Match #141109's shared-state reader without importing stores that can migrate.
function readContentVersion(database, kind, published) {
  if (
    kind !== "state" ||
    !database
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'config_machine_state'")
      .get()
  ) {
    return published;
  }
  const row = database
    .prepare("SELECT value_json FROM config_machine_state WHERE state_key = ?")
    .get("state.schema.contentVersion");
  if (!row) {
    return published;
  }
  const contentVersion = JSON.parse(row.value_json);
  assert(
    Number.isSafeInteger(contentVersion) && contentVersion >= 0,
    "invalid shared state schema content version",
  );
  return Math.max(published, contentVersion);
}

function readSchemas(stateDir) {
  const paths = [{ kind: "state", relative: "state/openclaw.sqlite" }];
  const agentsDir = path.join(stateDir, "agents");
  if (fs.existsSync(agentsDir)) {
    for (const agent of fs.readdirSync(agentsDir, { withFileTypes: true })) {
      if (agent.isDirectory()) {
        const relative = `agents/${agent.name}/agent/openclaw-agent.sqlite`;
        if (fs.existsSync(path.join(stateDir, relative))) {
          paths.push({ kind: "agent", relative });
        }
      }
    }
  }
  return paths
    .toSorted((a, b) => a.relative.localeCompare(b.relative))
    .map((entry) => {
      const databasePath = path.join(stateDir, entry.relative);
      if (!fs.existsSync(databasePath)) {
        return {
          kind: entry.kind,
          relative: entry.relative,
          userVersion: null,
          contentVersion: null,
        };
      }
      // Never import a runtime store: the observer must not perform a migration.
      const database = new DatabaseSync(databasePath, { readOnly: true });
      try {
        const userVersion = database.prepare("PRAGMA user_version").get().user_version;
        return {
          kind: entry.kind,
          relative: entry.relative,
          userVersion,
          contentVersion: readContentVersion(database, entry.kind, userVersion),
        };
      } finally {
        database.close();
      }
    });
}

function prepare(baselineVersion, candidateTarball, stateDir, snapshotFile) {
  const manifest = JSON.parse(
    execFileSync("tar", ["-xOf", candidateTarball.replace(/^file:/u, ""), "package/package.json"], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    }),
  );
  assert.equal(manifest.name, "openclaw", "candidate is not an OpenClaw package");
  for (const kind of ["state", "agent"]) {
    assert(
      Number.isInteger(manifest.openclaw?.schemaVersions?.[kind]) &&
        manifest.openclaw.schemaVersions[kind] >= 0,
      `candidate package is missing its ${kind} schema version`,
    );
  }
  const snapshot = {
    baselineVersion,
    candidateVersion: manifest.version,
    candidateSchemaVersions: manifest.openclaw.schemaVersions,
    stateDir,
    databases: readSchemas(stateDir),
  };
  fs.writeFileSync(snapshotFile, `${JSON.stringify(snapshot, null, 2)}\n`);
  return "success";
}

function assertOutcome(snapshotFile, exitCode, installedVersion, acceptedOutcome, afterFile) {
  const snapshot = readJson(snapshotFile);
  // The updater result classifier owns post-core warnings; they can exit 1
  // after installing the candidate and completing its schema migrations.
  assert(
    acceptedOutcome === "success" || acceptedOutcome === "recoverable",
    "update outcome was not accepted by the updater result checks",
  );
  assert(
    Number(exitCode) === 0 || (acceptedOutcome === "recoverable" && Number(exitCode) === 1),
    "baseline requires a successful or validated recoverable update",
  );
  assert.equal(installedVersion, snapshot.candidateVersion, "candidate package is not installed");
  const databases = readSchemas(snapshot.stateDir);
  fs.writeFileSync(afterFile, `${JSON.stringify({ ...snapshot, databases }, null, 2)}\n`);
  const currentPaths = new Set(databases.map((database) => database.relative));
  for (const database of snapshot.databases) {
    if (database.userVersion !== null) {
      assert(
        currentPaths.has(database.relative),
        `baseline database missing after update: ${database.relative}`,
      );
    }
  }
  for (const database of databases) {
    assert.equal(
      database.contentVersion,
      snapshot.candidateSchemaVersions[database.kind],
      `${database.relative} does not have the candidate schema`,
    );
  }
  return "success";
}

try {
  const [command, ...args] = process.argv.slice(2);
  assert(
    (command === "prepare" && args.length === 4) || (command === "assert" && args.length === 5),
    "usage: schema-expectation.mjs prepare <baseline-version> <candidate.tgz> <state-dir> <snapshot.json> | assert <snapshot.json> <exit-code> <installed-version> <accepted-outcome> <after.json>",
  );
  process.stdout.write(`${command === "prepare" ? prepare(...args) : assertOutcome(...args)}\n`);
} catch (error) {
  process.stderr.write(`Schema expectation failed: ${error.message}\n`);
  process.exitCode = 1;
}
