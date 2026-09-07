import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

export function recordStoppedProof({ record, details, measure, exitCode }) {
  record("joined-stop", details);
  try {
    record("stop-resource-observation", { complete: true, measurement: measure() });
    return exitCode;
  } catch (error) {
    record("stop-resource-observation", { complete: false, error: String(error) });
    return exitCode || 1;
  }
}

// Launch receipts prove roots. The birth interval also charges uncertain detached consumers;
// it never labels them owned or interprets summed resident bytes as unique physical pages.
export class ProofMemoryScope {
  constructor({ identity, phase, census, currentPid, origin }) {
    assert(phase === "prebuild" || phase === "runtime");
    assert.equal(
      Boolean(origin),
      phase === "runtime",
      "Runtime requires the original prebuild memory scope",
    );
    this.identity = identity;
    this.launches = [];
    const rows = this.rows(census);
    const current = rows.get(currentPid);
    assert(current, "Current proof process is missing from the complete census");
    assert.equal(current.exitAbstime, "0", "Current collector is not a live process sample");
    this.current = this.instance(current);
    if (origin) {
      assert.equal(origin.version, 1);
      assert.deepEqual(origin.identity, identity, "Task memory scope belongs to another operation");
      assert.equal(origin.bootSession, census.bootSession, "Task memory scope crossed a host boot");
      assert(BigInt(this.current.startAbstime) >= BigInt(origin.process.startAbstime));
      this.origin = origin;
    } else {
      this.origin = {
        version: 1,
        identity,
        bootSession: census.bootSession,
        process: this.instance(this.current),
      };
    }
  }

  instance(row) {
    return { pid: row.pid, startAbstime: row.startAbstime };
  }

  key(row) {
    return `${row.pid}/${row.startAbstime}`;
  }

  rows(census) {
    assert.equal(census.complete, true, "Incomplete process census; task memory is unknown");
    assert.equal(typeof census.bootSession, "string");
    assert(census.bootSession.length > 0);
    const rows = new Map();
    for (const row of census.processes) {
      assert(Number.isSafeInteger(row.pid) && row.pid > 0);
      assert.match(row.startAbstime, /^[0-9]+$/);
      assert.match(row.exitAbstime, /^[0-9]+$/);
      assert.match(row.rssBytes, /^[0-9]+$/);
      assert(BigInt(row.rssBytes) <= BigInt(Number.MAX_SAFE_INTEGER));
      assert.equal(row.status, 0, "Unsuccessful process query cannot become a resident sample");
      assert.equal(row.errno, 0);
      assert(!rows.has(row.pid), "Duplicate PID in process census");
      rows.set(row.pid, row);
    }
    return rows;
  }

  spawned(name, pid) {
    assert(Number.isSafeInteger(pid) && pid > 0);
    assert(!this.launches.some((entry) => entry.pid === pid && !entry.exited));
    const launch = { name, pid, exited: false };
    this.launches.push(launch);
    return launch;
  }

  exited(launch, result) {
    assert(this.launches.includes(launch) && !launch.exited);
    launch.exited = true;
    launch.result = result;
  }

  observe(census) {
    const rows = this.rows(census);
    assert.equal(
      census.bootSession,
      this.origin.bootSession,
      "Task memory scope crossed a host boot",
    );
    const current = rows.get(this.current.pid);
    assert(current, "Live proof collector observation is missing");
    assert.deepEqual(
      this.instance(current),
      this.instance(this.current),
      "Proof collector instance changed",
    );
    assert.equal(current.exitAbstime, "0", "Current collector is not a live process sample");
    const verified = new Set([this.key(current)]);
    for (const launch of this.launches) {
      const row = rows.get(launch.pid);
      if (launch.exited) {
        assert(
          !row ||
            !launch.instance ||
            this.key(row) !== this.key(launch.instance) ||
            row.exitAbstime !== "0",
          "A exited process still has a live instance observation",
        );
        continue;
      }
      assert(row, `Live ${launch.name} process observation is missing`);
      assert(
        BigInt(row.startAbstime) >= BigInt(this.origin.process.startAbstime),
        "Spawn receipt cannot acquire a pre-existing process",
      );
      if (launch.instance) {
        assert.deepEqual(
          this.instance(row),
          launch.instance,
          `Live ${launch.name} process instance changed`,
        );
      } else {
        launch.instance = this.instance(row);
      }
      verified.add(this.key(row));
    }
    const charges = [];
    const terminalSamples = [];
    let taskRSS = 0;
    for (const row of rows.values()) {
      if (BigInt(row.startAbstime) < BigInt(this.origin.process.startAbstime)) continue;
      if (row.exitAbstime !== "0") {
        terminalSamples.push({
          ...this.instance(row),
          exitAbstime: row.exitAbstime,
          cachedResidentBytes: row.rssBytes,
        });
        continue;
      }
      const reason = verified.has(this.key(row))
        ? "verified-launch-root"
        : "conservative-later-birth";
      taskRSS += Number(row.rssBytes);
      assert(Number.isSafeInteger(taskRSS), "Resident sum exceeds exact integer range");
      charges.push({ ...this.instance(row), rssBytes: Number(row.rssBytes), reason });
    }
    return {
      taskRSS,
      metric: "sum-of-resident-bytes-with-conservative-later-birth-charges",
      origin: this.origin,
      charges,
      terminalSamples,
      launches: this.launches.map(({ name, pid, instance, exited, result }) => ({
        name,
        pid,
        instance,
        exited,
        result,
      })),
    };
  }
}

// Source verification and native measurement stay with their callers; this owns durable admission.
export function admitProof({ root, identity, verifySource, measure, redact }) {
  assert(!existsSync(root), "Preserve prior evidence; no overwrite or unchanged retry");
  const publicOutput = path.join(root, "public");
  mkdirSync(publicOutput, { recursive: true, mode: 0o700 });
  mkdirSync(path.join(root, "private"), { mode: 0o700 });
  const preflight = { ...identity, state: "starting", stage: "source", sourceVerified: false };
  const save = () =>
    writeFileSync(
      path.join(publicOutput, "preflight.json"),
      redact(JSON.stringify(preflight, null, 2)) + "\n",
    );
  const record = (event, details = {}) =>
    appendFileSync(
      path.join(publicOutput, "phase.jsonl"),
      redact(JSON.stringify({ at: Date.now(), event, ...details })) + "\n",
    );
  save();
  try {
    Object.assign(preflight, verifySource(record));
    preflight.sourceVerified = true;
    preflight.stage = "measurement";
    save();
    preflight.measurement = measure(record);
    const sample = preflight.measurement;
    const gib = 1024 ** 3;
    preflight.conditions = {
      physicalMemory: sample.memory >= 6 * gib,
      freeMemory: sample.freeMemory >= 2 * gib,
      taskResidentMemory: sample.taskRSS < 5 * gib,
      disk: sample.freeDisk >= 24 * gib,
    };
    preflight.stage = "admission";
    preflight.state = "measured";
    save();
    record("admission-measurement", sample);
    assert(preflight.conditions.physicalMemory, "Need at least 6 GiB physical Mac memory");
    assert(preflight.conditions.freeMemory, "Need at least 2 GiB free-plus-inactive Mac memory");
    assert(
      preflight.conditions.taskResidentMemory,
      "Task resident sum must remain below 5 GiB at entry",
    );
    assert(preflight.conditions.disk, "Need 20 GiB normal writes and 4 GiB exit/export reserve");
    preflight.state = "admitted";
    save();
    record("admitted-measurement", sample);
    return { preflight, record };
  } catch (error) {
    preflight.state = "refused";
    preflight.error = String(error);
    save();
    record("admission-refused", {
      stage: preflight.stage,
      sourceVerified: preflight.sourceVerified,
      error: String(error),
    });
    throw error;
  }
}
