import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

// This release line shipped the ledger before #138839 fenced post-Doctor
// access. Delete this exception when the planned migration deferral replaces it.
const UNFENCED_LEDGER_UPDATER_RELEASE_LINE = "2026.9.2";

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
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
        return { kind: entry.kind, relative: entry.relative, userVersion: null };
      }
      // Never import a runtime store: the observer must not perform a migration.
      const database = new DatabaseSync(databasePath, { readOnly: true });
      try {
        return {
          kind: entry.kind,
          relative: entry.relative,
          userVersion: database.prepare("PRAGMA user_version").get().user_version,
        };
      } finally {
        database.close();
      }
    });
}

function packageFingerprint(packageRoot) {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  function visit(relative) {
    const absolute = path.join(packageRoot, relative);
    const stat = fs.lstatSync(absolute);
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(absolute).toSorted()) {
        visit(path.join(relative, name));
      }
    } else if (stat.isSymbolicLink()) {
      hash.update(`link\0${relative}\0${fs.readlinkSync(absolute)}\0`);
    } else {
      assert(stat.isFile(), "package contains an unsupported file type");
      hash.update(`file\0${relative}\0${stat.mode & 0o777}\0${stat.size}\0`);
      const file = fs.openSync(absolute, "r");
      try {
        let bytes;
        while ((bytes = fs.readSync(file, buffer, 0, buffer.length, null)) !== 0) {
          hash.update(buffer.subarray(0, bytes));
        }
      } finally {
        fs.closeSync(file);
      }
    }
  }
  visit("");
  return hash.digest("hex");
}

function expectedOutcome(snapshot) {
  const releaseLine = snapshot.baselineVersion.match(/^(\d{4}\.\d+\.\d+)(?:[-+][\w.-]+)?$/u)?.[1];
  const migrationPending = snapshot.databases.some(
    (database) =>
      database.userVersion !== null &&
      database.userVersion < snapshot.candidateSchemaVersions[database.kind],
  );
  return releaseLine === UNFENCED_LEDGER_UPDATER_RELEASE_LINE && migrationPending
    ? "schema-refusal"
    : "success";
}

function prepare(baselineVersion, candidateTarball, stateDir, snapshotFile, packageRoot) {
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
    baselinePackageFingerprint: packageFingerprint(packageRoot),
  };
  fs.writeFileSync(snapshotFile, `${JSON.stringify(snapshot, null, 2)}\n`);
  return expectedOutcome(snapshot);
}

function hasTypedRefusal(text) {
  if (/\bDoctorUpdateSchemaRefusalError:/u.test(text)) {
    return true;
  }
  try {
    const result = JSON.parse(text);
    return result?.ok === false && result.error?.code === "update-schema-bump-unfenced";
  } catch {
    return false;
  }
}

function assertOutcome(
  snapshotFile,
  exitCode,
  installedVersion,
  updateFile,
  errorFile,
  observationRoot,
  packageRoot,
) {
  const snapshot = readJson(snapshotFile);
  const expected = expectedOutcome(snapshot);
  if (expected === "success") {
    assert.equal(Number(exitCode), 0, "baseline requires a successful update");
    assert.equal(installedVersion, snapshot.candidateVersion, "candidate package is not installed");
    const databases = readSchemas(snapshot.stateDir);
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
        database.userVersion,
        snapshot.candidateSchemaVersions[database.kind],
        `${database.relative} does not have the candidate schema`,
      );
    }
    return expected;
  }
  assert.equal(Number(exitCode), 1, "schema refusal must exit with status 1");
  assert.equal(
    installedVersion,
    snapshot.baselineVersion,
    "previous package version was not restored",
  );
  assert.equal(
    packageFingerprint(packageRoot),
    snapshot.baselinePackageFingerprint,
    "previous package bytes were not restored",
  );
  assert.deepEqual(
    readSchemas(snapshot.stateDir),
    snapshot.databases,
    "schema refusal changed the baseline databases",
  );
  const raw = fs.readFileSync(updateFile, "utf8");
  const firstObject = raw.indexOf("{");
  assert(firstObject !== -1, "schema refusal has no updater result");
  const result = JSON.parse(raw.slice(firstObject));
  assert.equal(result.status, "error", "schema refusal was not an updater error");
  assert.equal(result.before?.version, snapshot.baselineVersion, "updater used another baseline");
  const doctor = result.steps?.find((step) => step.name === "openclaw doctor");
  assert.equal(doctor?.exitCode, 1, "schema refusal has no failed Doctor step");
  assert(
    [doctor.stdoutTail ?? "", doctor.stderrTail ?? "", fs.readFileSync(errorFile, "utf8")].some(
      hasTypedRefusal,
    ),
    "update failed without the typed schema refusal",
  );
  const diagnosticsDir = path.join(observationRoot, "diagnostics");
  const doctorExited = fs
    .readdirSync(diagnosticsDir)
    .filter((name) => /^process-\d+-exited\.json$/u.test(name))
    .map((name) => readJson(path.join(diagnosticsDir, name)))
    .some(
      (entry) =>
        entry.role === "doctor" &&
        entry.packageVersion === snapshot.candidateVersion &&
        entry.event === "exited" &&
        entry.exitCode === 1,
    );
  assert(doctorExited, "candidate Doctor has no observed refusal exit");
  return expected;
}

try {
  const [command, ...args] = process.argv.slice(2);
  assert(
    (command === "prepare" && args.length === 5) || (command === "assert" && args.length === 7),
    "usage: schema-expectation.mjs prepare <baseline-version> <candidate.tgz> <state-dir> <snapshot.json> <package-root> | assert <snapshot.json> <exit-code> <installed-version> <update.json> <update.err> <observation-root> <package-root>",
  );
  process.stdout.write(`${command === "prepare" ? prepare(...args) : assertOutcome(...args)}\n`);
} catch (error) {
  process.stderr.write(`Schema expectation failed: ${error.message}\n`);
  process.exitCode = 1;
}
