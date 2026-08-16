import { createWorkspaceQuiescenceResumeScript } from "./workspace-quiescence-resume-script.js";

const REMOTE_WATCHDOG_PROCESS_PROBE_TIMEOUT_MS = 1_000;
// Covers the whole pass; exhaustion leaves an operator-visible terminal lease.
const REMOTE_WATCHDOG_PROCESS_RECOVERY_TIMEOUT_MS = 5_000;
const REMOTE_QUIESCENCE_PROCESS_PROBE_CONCURRENCY = 8;
export const WORKER_WORKSPACE_OPERATOR_RECOVERY_EXIT_CODE = 75;

const REMOTE_QUIESCENCE_PS_JS = String.raw`function processes() {
  const output = childProcess.execFileSync("ps", ["-axo", "pid=,ppid=,uid=,stat=,lstart="], {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    timeout: 2000,
  });
  const rows = new Map();
  for (const line of output.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
    if (!match) continue;
    rows.set(Number(match[1]), {
      ppid: Number(match[2]),
      uid: Number(match[3]),
      state: match[4],
      start: match[5],
    });
  }
  return rows;
}
function ancestors(rows) {
  const result = new Set();
  let pid = process.pid;
  while (pid > 0 && !result.has(pid)) {
    result.add(pid);
    pid = rows.get(pid)?.ppid || 0;
  }
  return result;
}
function probeProcessIdentity(pid, timeoutMs = ${REMOTE_WATCHDOG_PROCESS_PROBE_TIMEOUT_MS}) {
  return new Promise((resolve) => {
    let settled = false; let deadline;
    const finish = (value) => { if (settled) return; settled = true; clearTimeout(deadline); resolve(value); };
    const child = childProcess.execFile("ps", ["-o", "stat=,lstart=", "-p", String(pid)], { encoding: "utf8", maxBuffer: 4096 }, (error, stdout) => {
      const match = /^(\S+)\s+(.+)$/u.exec(stdout.trim());
      if (!error && match) finish({ kind: "identity", state: match[1], start: match[2] });
      else if (!error) finish({ kind: "missing" });
      else if (error.code === 1 || error.status === 1) finish({ kind: "missing" });
      else if (error.code === "EAGAIN" || error.code === "EMFILE") finish({ kind: "timeout" });
      else finish({ kind: "failed" });
    });
    deadline = setTimeout(() => {
      if (settled) return;
      settled = true; child.stdout?.destroy(); child.stderr?.destroy(); child.unref();
      try { child.kill("SIGKILL"); } catch {}
      resolve({ kind: "timeout" });
    }, timeoutMs);
  });
}
function processReferenceDeadlineMs(referenceCount) {
  const probeBatches = Math.ceil(referenceCount / ${REMOTE_QUIESCENCE_PROCESS_PROBE_CONCURRENCY});
  return Date.now() + Math.max(
    ${REMOTE_WATCHDOG_PROCESS_RECOVERY_TIMEOUT_MS},
    (probeBatches + 1) * ${REMOTE_WATCHDOG_PROCESS_PROBE_TIMEOUT_MS},
  );
}
async function signalProcessReferences(references, concurrency = ${REMOTE_QUIESCENCE_PROCESS_PROBE_CONCURRENCY}, deadlineMs = Date.now() + ${REMOTE_WATCHDOG_PROCESS_RECOVERY_TIMEOUT_MS}) {
  // Keep identity confirmation adjacent to its signal so a slow sibling probe cannot stale it.
  const results = new Array(references.length);
  let nextIndex = 0;
  const worker = async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= references.length) return;
      if (Date.now() >= deadlineMs) {
        results[index] = { kind: "deferred" };
        continue;
      }
      const reference = references[index];
      const observed = await probeProcessIdentity(
        reference.pid,
        Math.min(${REMOTE_WATCHDOG_PROCESS_PROBE_TIMEOUT_MS}, deadlineMs - Date.now()),
      );
      if (observed.kind === "timeout") {
        results[index] = observed;
        continue;
      }
      if (observed.kind === "failed") {
        results[index] = observed;
        continue;
      }
      if (observed.kind !== "identity" || observed.start !== reference.start) {
        results[index] = { kind: "missing" };
        continue;
      }
      try {
        const signal = reference.signal === "SIGTERM" && /^[Tt]/u.test(observed.state) ? "SIGKILL" : reference.signal;
        process.kill(reference.pid, signal);
        results[index] = { kind: "signaled", state: observed.state };
      } catch (error) {
        if (error && error.code === "ESRCH") results[index] = { kind: "missing" };
        else {
          results[index] = { kind: "failed" };
        }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, references.length) }, worker));
  return results;
}
function remainingProcessReferences(references, outcomes) {
  return references.filter(
    (_reference, index) =>
      outcomes[index].kind === "deferred" ||
      outcomes[index].kind === "timeout" ||
      outcomes[index].kind === "failed",
  );
}
async function recoverProcessReferences(references, concurrency = ${REMOTE_QUIESCENCE_PROCESS_PROBE_CONCURRENCY}, deadlineMs = Date.now() + ${REMOTE_WATCHDOG_PROCESS_RECOVERY_TIMEOUT_MS}) {
  let remaining = references;
  const failedReferences = new Set();
  const settled = new Map();
  while (remaining.length > 0 && Date.now() < deadlineMs) {
    const outcomes = await signalProcessReferences(remaining, concurrency, deadlineMs);
    outcomes.forEach((outcome, index) => {
      if (outcome.kind === "failed") failedReferences.add(remaining[index]);
      if (outcome.kind !== "deferred" && outcome.kind !== "timeout" && outcome.kind !== "failed") {
        settled.set(remaining[index], outcome);
      }
    });
    remaining = remainingProcessReferences(remaining, outcomes);
    if (failedReferences.size > 0 || remaining.length === 0 || Date.now() >= deadlineMs) break;
    await new Promise((resolve) => setTimeout(
      resolve,
      Math.min(${REMOTE_WATCHDOG_PROCESS_PROBE_TIMEOUT_MS}, deadlineMs - Date.now()),
    ));
  }
  return { remaining, failed: failedReferences.size > 0, failedReferences, settled };
}
function quiescenceCandidates(rows, expectedUid, excludedPids, frozen) {
  const preserved = ancestors(rows);
  return [...rows.entries()].filter(
    ([pid, row]) =>
      row.uid === expectedUid &&
      !preserved.has(pid) &&
      row.ppid !== process.pid &&
      !excludedPids.has(pid) &&
      (!frozen || !frozen.has(pid)) &&
      !row.state.startsWith("T") &&
      !row.state.startsWith("Z") &&
      !row.state.startsWith("X"),
  );
}`;

const REMOTE_QUIESCENCE_LEASE_JS = String.raw`class WorkspaceOperatorRecoveryError extends Error {}
function validProcessReference(value) {
  return value && Number.isSafeInteger(value.pid) && value.pid > 0 && typeof value.start === "string" && value.start.length > 0 && value.start.length <= 128;
}
function validRecovery(value) {
  return value === undefined || (value && (value.state === "probe-timeout" || value.state === "recovery-failed") && Number.isSafeInteger(value.failedAtMs) && value.failedAtMs > 0);
}
function sameProcessReferences(left, right) {
  return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((entry, index) => entry.pid === right[index].pid && entry.start === right[index].start);
}
function parseLease(raw, expectedNonce, options = {}) {
  const lease = JSON.parse(raw);
  if (
    !lease ||
    lease.version !== 1 ||
    lease.nonce !== expectedNonce ||
    (lease.sharedHost !== undefined && typeof lease.sharedHost !== "boolean") ||
    !Array.isArray(lease.processes) ||
    lease.processes.length > 4096 ||
    lease.processes.some((entry) => !validProcessReference(entry)) ||
    (lease.watchdog !== null && !validProcessReference(lease.watchdog)) ||
    !validRecovery(lease.recovery) ||
    (options.requireWatchdog && lease.watchdog === null) ||
    !Number.isSafeInteger(lease.expiresAtMs) ||
    lease.expiresAtMs < 1 ||
    (options.minimumRemainingMs && lease.expiresAtMs - Date.now() < options.minimumRemainingMs)
  ) {
    throw new Error(options.errorMessage || "invalid workspace quiescence lease");
  }
  return lease;
}
function persistLease(targetPath, lease, verifyCurrent) {
  if (verifyCurrent) verifyCurrent(JSON.parse(fs.readFileSync(targetPath, "utf8")));
  const temporary = targetPath + "." + process.pid + "." + crypto.randomBytes(8).toString("hex");
  fs.writeFileSync(temporary, JSON.stringify(lease), { mode: 0o600, flag: "wx" });
  fs.renameSync(temporary, targetPath);
}`;

export const REMOTE_WORKSPACE_QUIESCE_JS = String.raw`const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const root = fs.realpathSync(process.argv[1]);
if (typeof process.getuid !== "function") throw new Error("workspace quiescence requires POSIX");
const uid = process.getuid();
if (uid === 0) throw new Error("workspace quiescence refuses root-owned worker sessions");
const sleeper = new Int32Array(new SharedArrayBuffer(4));
const leaseDirectory = path.join(os.homedir(), ".openclaw-worker", "quiescence");
fs.mkdirSync(leaseDirectory, { recursive: true, mode: 0o700 });
fs.chmodSync(leaseDirectory, 0o700);
const workspaceKey = crypto.createHash("sha256").update(root).digest("hex");
const nonce = crypto.randomBytes(16).toString("hex");
const leasePath = path.join(leaseDirectory, workspaceKey + "." + nonce + ".json");
const watchdogTimeoutMs = Number(process.argv[2] || 12 * 60 * 1000);
if (!Number.isSafeInteger(watchdogTimeoutMs) || watchdogTimeoutMs < 1) throw new Error("invalid watchdog timeout");
const isolationMode = process.argv[3] || "dedicated";
if (isolationMode !== "dedicated" && isolationMode !== "shared-host") throw new Error("invalid workspace quiescence isolation mode");
const sharedHost = isolationMode === "shared-host";
${REMOTE_QUIESCENCE_PS_JS}
${REMOTE_QUIESCENCE_LEASE_JS}
const frozen = new Map();
let watchdogReference = null;
function writeLease(expiresAtMs = Date.now() + watchdogTimeoutMs) {
  persistLease(leasePath, {
    version: 1,
    nonce,
    sharedHost,
    processes: [...frozen].map(([pid, start]) => ({ pid, start })),
    watchdog: watchdogReference,
    expiresAtMs,
  });
}
async function recoverOrphanLeases(orphanNames) {
  const orphans = []; let retainedOperatorRecovery = false;
  for (const name of orphanNames) {
    const match = name.match(/^[a-f0-9]{64}\.([a-f0-9]{32})\.json$/);
    if (!match) continue;
    const orphanPath = path.join(leaseDirectory, name);
    let raw;
    try { raw = fs.readFileSync(orphanPath, "utf8"); }
    catch (error) { if (error && error.code === "ENOENT") continue; throw error; }
    const lease = parseLease(raw, match[1]);
    if (lease.recovery !== undefined) { retainedOperatorRecovery = true; continue; }
    const references = [
      ...(lease.watchdog === null ? [] : [{ ...lease.watchdog, signal: "SIGTERM" }]),
      ...lease.processes.map((entry) => ({ ...entry, signal: "SIGCONT" })),
    ];
    orphans.push({ orphanPath, lease, references });
  }
  const recovery = await recoverProcessReferences(
    orphans.flatMap((orphan) => orphan.references),
    ${REMOTE_QUIESCENCE_PROCESS_PROBE_CONCURRENCY},
    Date.now() + ${REMOTE_WATCHDOG_PROCESS_RECOVERY_TIMEOUT_MS},
  );
  const remaining = new Set(recovery.remaining);
  let retained = retainedOperatorRecovery;
  let failed = false;
  for (const { orphanPath, lease, references } of orphans) {
    const unresolved = references.filter((reference) => remaining.has(reference));
    if (unresolved.length === 0) { fs.unlinkSync(orphanPath); continue; }
    retained = true;
    const leaseFailed = unresolved.some((reference) => recovery.failedReferences.has(reference));
    failed = failed || leaseFailed;
    const watchdog = unresolved.find((entry) => entry.signal === "SIGTERM") ?? null;
    const processes = unresolved.filter((entry) => entry.signal === "SIGCONT").map(({ pid, start }) => ({ pid, start }));
    persistLease(orphanPath, {
      ...lease,
      processes,
      watchdog: watchdog === null ? null : { pid: watchdog.pid, start: watchdog.start },
      recovery: { state: leaseFailed ? "recovery-failed" : "probe-timeout", failedAtMs: Date.now() },
    }, (current) => {
      if (current.nonce !== lease.nonce || current.expiresAtMs !== lease.expiresAtMs || current.watchdog?.pid !== lease.watchdog?.pid || current.watchdog?.start !== lease.watchdog?.start || !sameProcessReferences(current.processes, lease.processes)) {
        throw new Error("workspace quiescence lease changed during orphan recovery");
      }
    });
  }
  if (retained) throw new WorkspaceOperatorRecoveryError("workspace quiescence orphan recovery " + (retainedOperatorRecovery ? "requires operator action" : failed ? "failed" : "timed out") + "; lease retained for operator recovery");
}
async function quiesce() {
const orphanNames = fs.readdirSync(leaseDirectory).filter((name) =>
  name.startsWith(workspaceKey + ".") && name.endsWith(".json"),
);
if (orphanNames.length > 16) throw new Error("too many workspace quiescence leases");
await recoverOrphanLeases(orphanNames);
writeLease();
const watchdogSource = [
  'const childProcess = require("node:child_process");',
  'const crypto = require("node:crypto");',
  'const fs = require("node:fs");',
  probeProcessIdentity.toString(),
  signalProcessReferences.toString(),
  remainingProcessReferences.toString(),
  recoverProcessReferences.toString(),
  validProcessReference.toString(),
  validRecovery.toString(),
  sameProcessReferences.toString(),
  parseLease.toString(),
  persistLease.toString(),
  "(" + watchdogMain.toString() + ")(process.argv[1], process.argv[2]);",
].join("\n");
const watchdog = childProcess.spawn(
  process.execPath,
  ["-e", watchdogSource, leasePath, nonce],
  { detached: true, stdio: "ignore" },
);
watchdog.unref();
if (!Number.isSafeInteger(watchdog.pid) || watchdog.pid < 1) {
  fs.unlinkSync(leasePath);
  throw new Error("workspace quiescence watchdog did not start");
}
let watchdogStart = null;
let watchdogProbeFailed = false;
const watchdogProbeDeadlineMs = Date.now() + ${REMOTE_WATCHDOG_PROCESS_PROBE_TIMEOUT_MS};
for (let attempt = 0; attempt < 100 && !watchdogStart && Date.now() < watchdogProbeDeadlineMs; attempt += 1) {
  const observed = await probeProcessIdentity(watchdog.pid, Math.max(1, watchdogProbeDeadlineMs - Date.now()));
  if (observed.kind === "failed") {
    watchdogProbeFailed = true;
    break;
  }
  watchdogStart = observed.kind === "identity" ? observed.start : null;
  if (!watchdogStart && Date.now() < watchdogProbeDeadlineMs) Atomics.wait(sleeper, 0, 0, Math.min(10, watchdogProbeDeadlineMs - Date.now()));
}
if (!watchdogStart) {
  try { process.kill(watchdog.pid, "SIGTERM"); } catch {}
  fs.unlinkSync(leasePath);
  throw new Error(
    watchdogProbeFailed
      ? "workspace quiescence watchdog identity probe failed"
      : "workspace quiescence watchdog identity was not observable",
  );
}
watchdogReference = { pid: watchdog.pid, start: watchdogStart };
writeLease();
let quietScans = 0;
try {
  if (sharedHost) {
    // Manifest stability fences still protect the workspace. Only skip the
    // uid-wide sweep because this provider declared processes outside this lease.
    process.stderr.write("workspace quiescence: shared host declared; skipping process freeze sweep\n");
    quietScans = 3;
  }
  for (let attempt = 0; !sharedHost && attempt < 250 && quietScans < 3; attempt += 1) {
    const candidates = quiescenceCandidates(
      processes(),
      uid,
      new Set([watchdog.pid]),
      frozen,
    );
    if (candidates.length + frozen.size > 4096) {
      throw new Error("too many worker processes to quiesce safely");
    }
    if (candidates.length > 0) {
      for (const [pid, row] of candidates) frozen.set(pid, row.start);
      writeLease();
      const stopped = await recoverProcessReferences(
        candidates.map(([pid, row]) => ({ pid, start: row.start, signal: "SIGSTOP" })),
        ${REMOTE_QUIESCENCE_PROCESS_PROBE_CONCURRENCY},
        processReferenceDeadlineMs(candidates.length),
      );
      if (stopped.remaining.length > 0) {
        throw new Error(
          stopped.failed
            ? "workspace quiescence process identity probe failed"
            : "workspace quiescence process identity probe timed out",
        );
      }
      Atomics.wait(sleeper, 0, 0, 20);
      const stoppedRows = processes();
      for (const [pid, row] of candidates) {
        const current = stoppedRows.get(pid);
        if (!current || current.start !== row.start) {
          frozen.delete(pid);
        } else if (!current.state.startsWith("T")) {
          throw new Error("workspace quiescence process did not stop");
        }
      }
      writeLease();
    }
    Atomics.wait(sleeper, 0, 0, 20);
    const writable = quiescenceCandidates(
      processes(),
      uid,
      new Set([watchdog.pid]),
    ).length > 0;
    quietScans = writable ? 0 : quietScans + 1;
  }
  if (quietScans < 3) {
    throw new Error("worker processes did not reach a quiescent state");
  }
} catch (error) {
  const recovery = await recoverProcessReferences([
    { pid: watchdog.pid, start: watchdogStart, signal: "SIGTERM" },
    ...[...frozen].map(([pid, start]) => ({ pid, start, signal: "SIGCONT" })),
  ]);
  if (recovery.remaining.length === 0) {
    try { fs.unlinkSync(leasePath); } catch (unlinkError) { if (!unlinkError || unlinkError.code !== "ENOENT") throw unlinkError; }
    throw error;
  }
  const remainingWatchdog = recovery.remaining.find((entry) => entry.signal === "SIGTERM");
  const remainingProcesses = recovery.remaining
    .filter((entry) => entry.signal === "SIGCONT")
    .map(({ pid, start }) => ({ pid, start }));
  persistLease(leasePath, {
    version: 1,
    nonce,
    processes: remainingProcesses,
    watchdog: remainingWatchdog
      ? { pid: remainingWatchdog.pid, start: remainingWatchdog.start }
      : null,
    expiresAtMs: Date.now(),
    recovery: {
      state: recovery.failed ? "recovery-failed" : "probe-timeout",
      failedAtMs: Date.now(),
    },
  });
  const failure = recovery.failed ? "failed" : "timed out";
  throw new WorkspaceOperatorRecoveryError(
    "workspace quiescence recovery " + failure + "; lease retained for operator recovery",
    { cause: error },
  );
}
function watchdogMain(watchedLeasePath, watchedNonce) {
  const check = async () => {
    try {
      const lease = parseLease(fs.readFileSync(watchedLeasePath, "utf8"), watchedNonce);
      if (lease.recovery !== undefined) return;
      const remainingMs = lease.expiresAtMs - Date.now();
      if (remainingMs > 0) {
        setTimeout(check, Math.min(remainingMs, 60 * 1000));
        return;
      }
      // Re-read at expiry so a renewal that raced this wake-up wins before SIGCONT.
      const current = parseLease(fs.readFileSync(watchedLeasePath, "utf8"), watchedNonce);
      if (current.recovery !== undefined || current.watchdog === null) return;
      if (current.expiresAtMs > Date.now()) {
        setTimeout(check, Math.min(current.expiresAtMs - Date.now(), 60 * 1000));
        return;
      }
      const recovery = await recoverProcessReferences(
        current.processes.map((entry) => ({ ...entry, signal: "SIGCONT" })),
      );
      const remaining = recovery.remaining.map(({ pid, start }) => ({ pid, start }));
      if (remaining.length === 0) {
        fs.unlinkSync(watchedLeasePath);
        return;
      }
      persistLease(
        watchedLeasePath,
        {
          ...current,
          processes: remaining,
          watchdog: null,
          recovery: {
            state: recovery.failed ? "recovery-failed" : "probe-timeout",
            failedAtMs: Date.now(),
          },
        },
        (latest) => {
          if (
            latest.nonce !== current.nonce ||
            latest.expiresAtMs !== current.expiresAtMs ||
            latest.watchdog?.pid !== current.watchdog.pid ||
            latest.watchdog?.start !== current.watchdog.start ||
            !sameProcessReferences(latest.processes, current.processes)
          ) {
            throw new Error("workspace quiescence lease changed during watchdog recovery");
          }
        },
      );
    } catch (error) {
      if (!error || error.code !== "ENOENT") process.exitCode = 1;
    }
  };
  void check();
}
process.stdout.write("quiesced " + nonce + "\n");
}
void quiesce().catch((error) => {
  console.error(error);
  process.exitCode = error instanceof WorkspaceOperatorRecoveryError
    ? ${WORKER_WORKSPACE_OPERATOR_RECOVERY_EXIT_CODE}
    : 1;
});
`;

export const REMOTE_WORKSPACE_RENEW_QUIESCENCE_JS = String.raw`const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const root = fs.realpathSync(process.argv[1]);
const nonce = process.argv[2];
const timeoutMs = Number(process.argv[3] || 12 * 60 * 1000);
const validationMode = process.argv[4] || "final";
const isolationMode = process.argv[5] || "dedicated";
if (typeof process.getuid !== "function") throw new Error("workspace quiescence requires POSIX");
const uid = process.getuid();
if (!/^[a-f0-9]{32}$/.test(nonce || "")) throw new Error("invalid workspace quiescence nonce");
if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 10 * 1000) throw new Error("invalid watchdog timeout");
if (validationMode !== "heartbeat" && validationMode !== "final") throw new Error("invalid workspace quiescence validation mode");
if (isolationMode !== "dedicated" && isolationMode !== "shared-host") throw new Error("invalid workspace quiescence isolation mode");
const sharedHost = isolationMode === "shared-host";
const leasePath = path.join(os.homedir(), ".openclaw-worker", "quiescence", crypto.createHash("sha256").update(root).digest("hex") + "." + nonce + ".json");
${REMOTE_QUIESCENCE_PS_JS}
${REMOTE_QUIESCENCE_LEASE_JS}
async function renew() {
const input = parseLease(fs.readFileSync(leasePath, "utf8"), nonce, {
  errorMessage: "workspace quiescence lease is no longer active",
});
if ((input.sharedHost === true) !== sharedHost) throw new Error("workspace quiescence isolation mode changed");
if (input.recovery !== undefined) {
  const failure = input.recovery.state === "recovery-failed" ? "failed" : "timed out";
  throw new WorkspaceOperatorRecoveryError("workspace quiescence recovery " + failure + "; lease retained for operator recovery");
}
const existingReferences = input.processes.map((entry) => ({ ...entry, signal: 0 }));
const existingValidationDeadlineMs = existingReferences.length === 0 ? Date.now() : processReferenceDeadlineMs(existingReferences.length);
const renewalDeadlineMs = existingValidationDeadlineMs + ${REMOTE_WATCHDOG_PROCESS_RECOVERY_TIMEOUT_MS};
if (input.watchdog === null || input.expiresAtMs <= renewalDeadlineMs) {
  throw new Error("workspace quiescence lease is no longer active");
}
function writeLease(processes, expiresAtMs) {
  persistLease(leasePath, { ...input, processes, expiresAtMs }, (current) => {
    if (
      current.nonce !== nonce ||
      current.expiresAtMs !== input.expiresAtMs ||
      current.recovery !== undefined ||
      current.watchdog?.pid !== input.watchdog.pid ||
      current.watchdog?.start !== input.watchdog.start ||
      !sameProcessReferences(current.processes, input.processes)
    ) {
      throw new Error("workspace quiescence lease changed during renewal");
    }
  });
  input.processes = processes;
  input.expiresAtMs = expiresAtMs;
}
async function assertWatchdogActive(deadlineMs = Date.now() + ${REMOTE_WATCHDOG_PROCESS_RECOVERY_TIMEOUT_MS}) {
  const reference = { ...input.watchdog, signal: 0 };
  const checked = await recoverProcessReferences([reference], ${REMOTE_QUIESCENCE_PROCESS_PROBE_CONCURRENCY}, deadlineMs);
  if (checked.remaining.length > 0 && !checked.failed) throw new Error("workspace quiescence watchdog identity probe timed out");
  if (checked.failed) throw new Error("workspace quiescence watchdog identity probe failed");
  const outcome = checked.settled.get(reference);
  if (outcome?.kind !== "signaled") throw new Error("workspace quiescence watchdog identity changed unexpectedly");
  if (/^[TtXZ]/u.test(outcome.state)) {
    throw new Error("workspace quiescence watchdog is not active");
  }
}
async function refreshLease(processes, watchdogDeadlineMs) {
  await assertWatchdogActive(watchdogDeadlineMs);
  writeLease(processes, Date.now() + timeoutMs);
}
async function rollbackLateProcesses(references, priorProcesses, error) {
  const rollback = await recoverProcessReferences(
    references.map((entry) => ({ ...entry, signal: "SIGCONT" })),
  );
  const retained = rollback.remaining.map(({ pid, start }) => ({ pid, start }));
  await refreshLease([
    ...priorProcesses,
    ...retained.filter(
      (entry) => !priorProcesses.some((prior) => prior.pid === entry.pid && prior.start === entry.start),
    ),
  ]);
  throw error;
}
const existing = await recoverProcessReferences(
  existingReferences,
  ${REMOTE_QUIESCENCE_PROCESS_PROBE_CONCURRENCY},
  existingValidationDeadlineMs,
);
if (existing.remaining.length > 0) throw new Error(existing.failed ? "workspace quiescence process identity probe failed" : "workspace quiescence process identity probe timed out");
for (const reference of existingReferences) {
  const outcome = existing.settled.get(reference);
  if (outcome?.kind === "signaled" && !outcome.state.startsWith("T")) {
    throw new Error("workspace quiescence process resumed unexpectedly");
  }
}
await refreshLease(
  input.processes,
  Math.min(renewalDeadlineMs, Date.now() + ${REMOTE_WATCHDOG_PROCESS_RECOVERY_TIMEOUT_MS}),
);
if (validationMode === "final" && !sharedHost) {
  const frozen = new Map(input.processes.map((entry) => [entry.pid, entry.start]));
  let quietScans = 0;
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  // A control tunnel can reconnect after the initial freeze; enroll every late process.
  for (let attempt = 0; attempt < 250 && quietScans < 3; attempt += 1) {
    const candidates = quiescenceCandidates(
      processes(),
      uid,
      new Set([input.watchdog.pid]),
    );
    if (candidates.length + frozen.size > 4096) {
      throw new Error("too many worker processes to quiesce safely");
    }
    const priorProcesses = input.processes.map((entry) => ({ ...entry }));
    for (const [pid, row] of candidates) frozen.set(pid, row.start);
    let frozenEntries = [...frozen].map(([pid, start]) => ({ pid, start }));
    await refreshLease(frozenEntries);
    if (candidates.length > 0) {
      const references = candidates.map(([pid, row]) => ({ pid, start: row.start }));
      const stopped = await recoverProcessReferences(
        references.map((entry) => ({ ...entry, signal: "SIGSTOP" })),
        ${REMOTE_QUIESCENCE_PROCESS_PROBE_CONCURRENCY},
        processReferenceDeadlineMs(references.length),
      );
      if (stopped.remaining.length > 0) {
        await rollbackLateProcesses(
          references,
          priorProcesses,
          new Error(
            stopped.failed
              ? "workspace quiescence process identity probe failed"
              : "workspace quiescence process identity probe timed out",
          ),
        );
      }
      Atomics.wait(sleeper, 0, 0, 20);
      const stoppedRows = processes();
      for (const [pid, row] of candidates) {
        const current = stoppedRows.get(pid);
        if (!current || current.start !== row.start) {
          frozen.delete(pid);
        } else if (!current.state.startsWith("T")) {
          await rollbackLateProcesses(
            references,
            priorProcesses,
            new Error("workspace quiescence process did not stop"),
          );
        }
      }
    }
    frozenEntries = [...frozen].map(([pid, start]) => ({ pid, start }));
    await refreshLease(frozenEntries);
    Atomics.wait(sleeper, 0, 0, 20);
    const unknownProcess = quiescenceCandidates(
      processes(),
      uid,
      new Set([input.watchdog.pid]),
    ).length > 0;
    quietScans = candidates.length > 0 || unknownProcess ? 0 : quietScans + 1;
  }
  if (quietScans < 3) {
    throw new Error("worker processes did not return to a quiescent state");
  }
  input.processes = [...frozen].map(([pid, start]) => ({ pid, start }));
}
const renewed = { ...input, expiresAtMs: Date.now() + timeoutMs };
await refreshLease(renewed.processes);
renewed.expiresAtMs = input.expiresAtMs;
const confirmed = JSON.parse(fs.readFileSync(leasePath, "utf8"));
if (confirmed.nonce !== nonce || confirmed.expiresAtMs !== renewed.expiresAtMs) {
  throw new Error("workspace quiescence renewal was not durable");
}
process.stdout.write("renewed " + nonce + "\n");
}
void renew().catch((error) => {
  console.error(error);
  process.exitCode = error instanceof WorkspaceOperatorRecoveryError
    ? ${WORKER_WORKSPACE_OPERATOR_RECOVERY_EXIT_CODE}
    : 1;
});
`;

export const REMOTE_WORKSPACE_RESUME_JS = createWorkspaceQuiescenceResumeScript({
  processScript: REMOTE_QUIESCENCE_PS_JS,
  leaseScript: REMOTE_QUIESCENCE_LEASE_JS,
  processProbeConcurrency: REMOTE_QUIESCENCE_PROCESS_PROBE_CONCURRENCY,
  operatorRecoveryExitCode: WORKER_WORKSPACE_OPERATOR_RECOVERY_EXIT_CODE,
});
