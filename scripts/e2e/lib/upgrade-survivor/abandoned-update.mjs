import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const runId = "f9bdb286-8f8a-4b72-a792-3ca83ad07605";
const [command, first, second, third] = process.argv.slice(2);
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const writeJson = (file, value) => fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);

function withDatabase(stateDir, write, callback) {
  const databasePath = path.join(stateDir, "state", "openclaw.sqlite");
  assert(fs.existsSync(databasePath), "the published Gateway must create its own state database");
  const db = new DatabaseSync(databasePath, { readOnly: !write });
  try {
    return callback(db);
  } finally {
    db.close();
  }
}

function readRun(db) {
  const row = db.prepare("SELECT * FROM update_runs WHERE run_id = ?").get(runId);
  assert(row, "the pre-upgrade ledger specimen disappeared");
  return row;
}

function seed(stateDir, artifactRoot) {
  withDatabase(stateDir, true, (db) => {
    assert.equal(
      db.prepare("SELECT count(*) AS total FROM update_runs WHERE status = 'running'").get().total,
      0,
      "the baseline preview must finish its ledger run before seeding",
    );
    // Deliberately older than the product's shared thirty-minute inactivity bound.
    const lastActivity = Date.now() - 60 * 60_000;
    const row = {
      run_id: runId,
      created_at_ms: lastActivity,
      updated_at_ms: lastActivity,
      trigger: "cli",
      phase: "requested",
      status: "running",
      reason: null,
      origin_json: "{}",
      target_json: "{}",
      before_json: JSON.stringify({ version: "2026.9.2" }),
      after_json: "{}",
      steps_json: JSON.stringify([
        { step: "requested", status: "in_progress", startedAtMs: lastActivity },
      ]),
      verification_json: "{}",
      repair_json: "[]",
      confirmed_at_ms: null,
      finished_at_ms: null,
      downtime_ms: null,
    };
    db.prepare(
      `INSERT INTO update_runs (${Object.keys(row).join(",")}) VALUES (${Object.keys(row)
        .map(() => "?")
        .join(",")})`,
    ).run(...Object.values(row));
    writeJson(path.join(artifactRoot, "abandoned-run-before.json"), readRun(db));
  });
}

function preserved(stateDir, artifactRoot) {
  withDatabase(stateDir, false, (db) => {
    assert.deepEqual(
      { ...readRun(db) },
      readJson(path.join(artifactRoot, "abandoned-run-before.json")),
      "upgrade and Gateway startup must preserve an identityless legacy run",
    );
    const active = db.prepare("SELECT run_id FROM update_runs WHERE status = 'running'").all();
    assert.deepEqual(
      active.map((row) => row.run_id),
      [runId],
      "the real updater must finish its own run",
    );
  });
}

function processIdentity(pid) {
  assert(Number.isSafeInteger(pid) && pid > 1, "invalid service process ID");
  const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
  const fields = stat.slice(stat.lastIndexOf(") ") + 2).split(" ");
  assert.notEqual(fields[0], "Z", "service process is a zombie");
  assert(fields[19], "process start time is missing");
  return { pid, startTime: fields[19] };
}

function gatewayListenerPid(supervisorPid) {
  const listeningSockets = new Set(
    ["tcp", "tcp6"].flatMap((name) =>
      fs
        .readFileSync(`/proc/net/${name}`, "utf8")
        .trim()
        .split("\n")
        .slice(1)
        .map((line) => line.trim().split(/\s+/u))
        .filter(
          (fields) => fields[3] === "0A" && Number.parseInt(fields[1].split(":")[1], 16) === 18789,
        )
        .map((fields) => `socket:[${fields[9]}]`),
    ),
  );
  assert(listeningSockets.size > 0, "the Gateway port must have a listening socket");
  const descendants = [supervisorPid];
  const listeners = [];
  for (const pid of descendants) {
    const children = fs
      .readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8")
      .trim()
      .split(/\s+/u)
      .filter(Boolean)
      .map(Number);
    descendants.push(...children);
    const ownsListener = fs.readdirSync(`/proc/${pid}/fd`).some((fd) => {
      try {
        return listeningSockets.has(fs.readlinkSync(`/proc/${pid}/fd/${fd}`));
      } catch (error) {
        if (error.code === "ENOENT") {
          return false;
        }
        throw error;
      }
    });
    if (ownsListener) {
      listeners.push(pid);
    }
  }
  assert.equal(listeners.length, 1, "one supervised Gateway must own the listening port");
  return listeners[0];
}

function service(pidFile, logFile, output) {
  const supervisorPid = Number(fs.readFileSync(pidFile, "utf8").trim());
  writeJson(output, {
    supervisor: processIdentity(supervisorPid),
    // The socket owner is authoritative even if a CLI respawn adds a wrapper.
    gateway: processIdentity(gatewayListenerPid(supervisorPid)),
    operations: fs.readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean),
  });
}

function packages(tarball, packageRoot, artifactRoot) {
  const packedJson = (relative) =>
    JSON.parse(execFileSync("tar", ["-xOf", tarball, `package/${relative}`], { encoding: "utf8" }));
  const baseline = {
    version: readJson(path.join(packageRoot, "package.json")).version,
    build: readJson(path.join(packageRoot, "dist", "build-info.json")),
  };
  const candidate = {
    version: packedJson("package.json").version,
    build: packedJson("dist/build-info.json"),
  };
  assert(
    baseline.build.buildId && candidate.build.buildId,
    "both packages must identify their build",
  );
  assert.notEqual(
    candidate.build.buildId,
    baseline.build.buildId,
    "candidate must be a distinct build, even when versions match",
  );
  writeJson(path.join(artifactRoot, "abandoned-update-packages.json"), { baseline, candidate });
}

function installed(packageRoot, artifactRoot) {
  const expected = readJson(path.join(artifactRoot, "abandoned-update-packages.json")).candidate;
  const actual = {
    version: readJson(path.join(packageRoot, "package.json")).version,
    build: readJson(path.join(packageRoot, "dist", "build-info.json")),
  };
  assert.deepEqual(actual, expected, "the updater must install the selected candidate build");
}

function recovered(stateDir, artifactRoot) {
  const before = readJson(path.join(artifactRoot, "repair-service-before.json"));
  const after = readJson(path.join(artifactRoot, "repair-service-after.json"));
  const repairExit = Number(fs.readFileSync(path.join(artifactRoot, "repair.exit"), "utf8"));
  const statusExit = Number(fs.readFileSync(path.join(artifactRoot, "update-status.exit"), "utf8"));
  const repairOutput = fs.readFileSync(path.join(artifactRoot, "repair.json"), "utf8");
  const repairError = fs.readFileSync(path.join(artifactRoot, "repair.err"), "utf8");
  const row = withDatabase(stateDir, false, readRun);
  const operations = after.operations.slice(before.operations.length);
  writeJson(path.join(artifactRoot, "abandoned-update-evidence.json"), {
    runId,
    repairExit,
    statusExit,
    row,
    serviceBefore: { supervisor: before.supervisor, gateway: before.gateway },
    serviceAfter: { supervisor: after.supervisor, gateway: after.gateway },
    operations,
    repairOutput,
    repairError,
  });
  assert.equal(repairExit, 0, `update repair failed: ${repairError || repairOutput}`);
  assert.equal(statusExit, 0, "update status failed");
  const repair = JSON.parse(repairOutput);
  assert.equal(repair.status, "ok");
  assert.equal(repair.mode, "repair", "ledger-only repair must not enter finalization/Doctor");
  assert.equal(repair.restart, false);
  assert.deepEqual(repair.reconciledRuns, [runId]);
  assert.match(repair.message, /No maintenance or service restart was needed/u);
  assert.equal(row.status, "failed");
  assert.equal(row.phase, "finished");
  assert.equal(row.reason, "abandoned");
  assert(Number.isSafeInteger(row.finished_at_ms));
  assert(
    JSON.parse(row.steps_json).some(
      (step) =>
        step.step === "reconcile:abandoned" && step.detail === "operator-reconciled-inactive-run",
    ),
  );
  const status = readJson(path.join(artifactRoot, "update-status.json"));
  assert.equal(status.activeRun, undefined, "update status must have no active run");
  assert.deepEqual(after.supervisor, before.supervisor, "repair replaced the service supervisor");
  assert.deepEqual(after.gateway, before.gateway, "repair replaced the Gateway process");
  assert(
    !operations.some((operation) =>
      /(?:^|\s)(?:stop|restart|start|enable|disable)(?:\s|$)/u.test(operation),
    ),
    `repair changed service activation: ${operations.join("; ")}`,
  );
  console.log(
    JSON.stringify({
      runId,
      status: row.status,
      reason: row.reason,
      repairExit,
      activeRun: null,
      gatewayPid: after.gateway.pid,
      serviceUnchanged: true,
    }),
  );
}

if (command === "seed") {
  seed(first, second);
} else if (command === "preserved") {
  preserved(first, second);
} else if (command === "service") {
  service(first, second, third);
} else if (command === "recovered") {
  recovered(first, second);
} else if (command === "packages") {
  packages(first, second, third);
} else if (command === "installed") {
  installed(first, second);
} else {
  throw new Error(`Unknown abandoned-update fixture command: ${command}`);
}
