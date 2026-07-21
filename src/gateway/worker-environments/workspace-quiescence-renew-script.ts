export const REMOTE_WORKSPACE_RENEW_QUIESCENCE_JS = String.raw`const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const root = fs.realpathSync(process.argv[1]);
const nonce = process.argv[2];
const timeoutMs = Number(process.argv[3] || 12 * 60 * 1000);
const validationMode = process.argv[4] || "final";
if (typeof process.getuid !== "function") throw new Error("workspace quiescence requires POSIX");
const uid = process.getuid();
if (!/^[a-f0-9]{32}$/.test(nonce || "")) throw new Error("invalid workspace quiescence nonce");
if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 10 * 1000) throw new Error("invalid watchdog timeout");
if (validationMode !== "heartbeat" && validationMode !== "final") throw new Error("invalid workspace quiescence validation mode");
const leasePath = path.join(os.homedir(), ".openclaw-worker", "quiescence", crypto.createHash("sha256").update(root).digest("hex") + "." + nonce + ".json");
const input = JSON.parse(fs.readFileSync(leasePath, "utf8"));
if (
  !input ||
  input.version !== 1 ||
  input.nonce !== nonce ||
  !Array.isArray(input.processes) ||
  input.processes.length > 4096 ||
  input.processes.some((entry) => !entry || !Number.isSafeInteger(entry.pid) || entry.pid < 1 || typeof entry.start !== "string" || !entry.start || entry.start.length > 128) ||
  !input.watchdog ||
  !Number.isSafeInteger(input.watchdog.pid) ||
  input.watchdog.pid < 1 ||
  typeof input.watchdog.start !== "string" ||
  !input.watchdog.start ||
  input.watchdog.start.length > 128 ||
  !Number.isSafeInteger(input.expiresAtMs) ||
  input.expiresAtMs - Date.now() < 5000
) {
  throw new Error("workspace quiescence lease is no longer active");
}
function processStatus(pid) {
  try {
    const output = childProcess.execFileSync("ps", ["-o", "stat=,lstart=", "-p", String(pid)], { encoding: "utf8", maxBuffer: 4096, timeout: 2000 }).trim();
    const match = /^(\S+)\s+(.+)$/u.exec(output);
    return match ? { state: match[1], start: match[2] } : null;
  } catch (error) {
    if (error && error.status === 1) return null;
    throw error;
  }
}
function processes() {
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
function persistLease(processes, expiresAtMs) {
  // workspace-sync.ts serializes heartbeat and final renewals through renewalQueue;
  // the watchdog only reads this lease, so one nonce has exactly one writer at a time.
  const current = JSON.parse(fs.readFileSync(leasePath, "utf8"));
  if (current.nonce !== nonce || current.watchdog?.pid !== input.watchdog.pid || current.watchdog?.start !== input.watchdog.start) {
    throw new Error("workspace quiescence lease changed during renewal");
  }
  const temporary = leasePath + "." + process.pid + "." + crypto.randomBytes(8).toString("hex");
  fs.writeFileSync(temporary, JSON.stringify({ ...input, processes, expiresAtMs }), { mode: 0o600, flag: "wx" });
  fs.renameSync(temporary, leasePath);
}
function assertWatchdogActive() {
  const status = processStatus(input.watchdog.pid);
  if (!status || status.start !== input.watchdog.start) {
    throw new Error("workspace quiescence watchdog identity changed unexpectedly");
  }
  try { process.kill(input.watchdog.pid, 0); } catch (error) {
    if (error && error.code === "ESRCH") throw new Error("workspace quiescence watchdog exited unexpectedly");
    throw error;
  }
}
function refreshLease(processes) {
  assertWatchdogActive();
  input.expiresAtMs = Date.now() + timeoutMs;
  persistLease(processes, input.expiresAtMs);
}
for (const entry of input.processes) {
  const status = processStatus(entry.pid);
  if (!status || status.start !== entry.start) continue;
  const state = status.state;
  if (state && !state.startsWith("T")) throw new Error("workspace quiescence process resumed unexpectedly");
}
refreshLease(input.processes);
if (validationMode === "final") {
  const frozen = new Map(input.processes.map((entry) => [entry.pid, entry.start]));
  let quietScans = 0;
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  // A control tunnel can reconnect after the initial freeze. Enroll and stop
  // every late process before the caller repeats its remote stability fence.
  for (let attempt = 0; attempt < 250 && quietScans < 3; attempt += 1) {
    const rows = processes();
    const preserved = ancestors(rows);
    const candidates = [...rows.entries()].filter(
      ([pid, row]) =>
        row.uid === uid &&
        !preserved.has(pid) &&
        row.ppid !== process.pid &&
        pid !== input.watchdog.pid &&
        !row.state.startsWith("T") &&
        !row.state.startsWith("Z") &&
        !row.state.startsWith("X"),
    );
    if (candidates.length + frozen.size > 4096) {
      throw new Error("too many worker processes to quiesce safely");
    }
    for (const [pid, row] of candidates) {
      frozen.set(pid, row.start);
    }
    let frozenEntries = [...frozen].map(([pid, start]) => ({ pid, start }));
    refreshLease(frozenEntries);
    for (const [pid, row] of candidates) {
      try {
        if (input.expiresAtMs - Date.now() < 5000) {
          refreshLease(frozenEntries);
        }
        const current = processStatus(pid);
        if (!current || current.start !== row.start) {
          frozen.delete(pid);
          continue;
        }
        if (input.expiresAtMs - Date.now() < 2500) {
          refreshLease(frozenEntries);
        }
        process.kill(pid, "SIGSTOP");
      } catch (error) {
        if (!error || error.code !== "ESRCH") throw error;
        frozen.delete(pid);
      }
    }
    frozenEntries = [...frozen].map(([pid, start]) => ({ pid, start }));
    refreshLease(frozenEntries);
    Atomics.wait(sleeper, 0, 0, 20);
    const after = processes();
    const afterPreserved = ancestors(after);
    const unknownProcess = [...after.entries()].some(
      ([pid, row]) =>
        row.uid === uid &&
        !afterPreserved.has(pid) &&
        row.ppid !== process.pid &&
        pid !== input.watchdog.pid &&
        !row.state.startsWith("T") &&
        !row.state.startsWith("Z") &&
        !row.state.startsWith("X"),
    );
    quietScans = candidates.length > 0 || unknownProcess ? 0 : quietScans + 1;
  }
  if (quietScans < 3) {
    throw new Error("worker processes did not return to a quiescent state");
  }
  input.processes = [...frozen].map(([pid, start]) => ({ pid, start }));
}
const renewed = { ...input, expiresAtMs: Date.now() + timeoutMs };
refreshLease(renewed.processes);
renewed.expiresAtMs = input.expiresAtMs;
const confirmed = JSON.parse(fs.readFileSync(leasePath, "utf8"));
if (confirmed.nonce !== nonce || confirmed.expiresAtMs !== renewed.expiresAtMs) {
  throw new Error("workspace quiescence renewal was not durable");
}
process.stdout.write("renewed " + nonce + "\n");
`;
