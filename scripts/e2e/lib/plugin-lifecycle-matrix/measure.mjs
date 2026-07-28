// Measures plugin lifecycle matrix E2E command timings.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const [summaryPath, phase, separator, command, ...args] = process.argv.slice(2);
if (!summaryPath || !phase || separator !== "--" || !command) {
  console.error("usage: measure.mjs <summary.tsv> <phase> -- <command> [args...]");
  process.exit(2);
}

function readPositiveIntEnv(name, fallback) {
  const text = String(process.env[name] ?? fallback).trim();
  if (!/^\d+$/u.test(text)) {
    throw new Error(`${name} must be a positive integer; got: ${text}`);
  }
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer; got: ${text}`);
  }
  return value;
}

function readPositiveIntEnvOrGetconf(name, variable) {
  if (process.env[name] !== undefined) {
    return readPositiveIntEnv(name, "");
  }
  const result = spawnSync("getconf", [variable], { encoding: "utf8" });
  if (result.error || result.status !== 0) {
    const details =
      result.error?.message || result.stderr.trim() || `exit ${String(result.status)}`;
    throw new Error(
      `failed to derive ${name} from getconf ${variable}: ${details}; set ${name} explicitly`,
    );
  }
  return readPositiveIntEnv(name, result.stdout);
}

function readPositiveNumberEnv(name, fallback) {
  const text = String(process.env[name] ?? fallback).trim();
  if (!/^\d+(?:\.\d+)?$/u.test(text)) {
    throw new Error(`${name} must be a positive number; got: ${text}`);
  }
  const value = Number(text);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number; got: ${text}`);
  }
  return value;
}

const MAX_TIMER_TIMEOUT_MS = 2_147_000_000;

function clampTimerTimeoutMs(valueMs) {
  return Math.min(Math.max(Math.floor(valueMs), 1), MAX_TIMER_TIMEOUT_MS);
}

const pollMs = clampTimerTimeoutMs(
  readPositiveIntEnv("OPENCLAW_PLUGIN_LIFECYCLE_METRIC_POLL_MS", 100),
);
const timeoutMs = clampTimerTimeoutMs(
  readPositiveIntEnv("OPENCLAW_PLUGIN_LIFECYCLE_PHASE_TIMEOUT_MS", 300000),
);
const timeoutKillGraceMs = clampTimerTimeoutMs(
  readPositiveIntEnv("OPENCLAW_PLUGIN_LIFECYCLE_TIMEOUT_KILL_GRACE_MS", 2000),
);
const maxRssKbThreshold = readPositiveIntEnv(
  "OPENCLAW_PLUGIN_LIFECYCLE_MAX_RSS_KB",
  4 * 1024 * 1024,
);
const maxWallMs = readPositiveIntEnv("OPENCLAW_PLUGIN_LIFECYCLE_MAX_WALL_MS", timeoutMs);
const maxCpuCoreRatio = readPositiveNumberEnv("OPENCLAW_PLUGIN_LIFECYCLE_MAX_CPU_CORE_RATIO", 16);

if (!fs.existsSync("/proc")) {
  console.error("plugin lifecycle resource sampler requires Linux /proc");
  process.exit(2);
}

// /proc RSS is in host pages and CPU times are in host clock ticks. Query the
// live units so 64 KiB ARM kernels do not under-report resource use.
const pageSize = readPositiveIntEnvOrGetconf("OPENCLAW_PROC_PAGE_SIZE", "PAGESIZE");
const clockTicks = readPositiveIntEnvOrGetconf("OPENCLAW_PROC_CLK_TCK", "CLK_TCK");

function readProcSnapshot() {
  const stats = new Map();
  for (const entry of fs.readdirSync("/proc", { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\d+$/u.test(entry.name)) {
      continue;
    }
    const pid = Number.parseInt(entry.name, 10);
    const statPath = path.join("/proc", entry.name, "stat");
    try {
      const raw = fs.readFileSync(statPath, "utf8");
      const closeParen = raw.lastIndexOf(")");
      if (closeParen === -1) {
        continue;
      }
      const fields = raw
        .slice(closeParen + 2)
        .trim()
        .split(/\s+/u);
      const ppid = Number.parseInt(fields[1] ?? "", 10);
      const pgrp = Number.parseInt(fields[2] ?? "", 10);
      const userTicks = Number.parseInt(fields[11] ?? "", 10);
      const systemTicks = Number.parseInt(fields[12] ?? "", 10);
      const rssPages = Number.parseInt(fields[21] ?? "", 10);
      if (
        !Number.isFinite(ppid) ||
        !Number.isFinite(pgrp) ||
        !Number.isFinite(userTicks) ||
        !Number.isFinite(systemTicks) ||
        !Number.isFinite(rssPages)
      ) {
        continue;
      }
      stats.set(pid, {
        ppid,
        pgrp,
        cpuTicks: userTicks + systemTicks,
        rssBytes: Math.max(0, rssPages) * pageSize,
      });
    } catch {
      // Processes can exit while /proc is being scanned.
    }
  }
  return stats;
}

function descendantsOf(rootPid, stats) {
  const children = new Map();
  for (const [pid, stat] of stats.entries()) {
    const siblings = children.get(stat.ppid) ?? [];
    siblings.push(pid);
    children.set(stat.ppid, siblings);
  }
  const seen = new Set([rootPid]);
  const queue = [rootPid];
  for (const queuedPid of queue) {
    for (const child of children.get(queuedPid) ?? []) {
      if (!seen.has(child)) {
        seen.add(child);
        queue.push(child);
      }
    }
  }
  return seen;
}

function sample(rootPid) {
  const stats = readProcSnapshot();
  const groupPids = new Set(
    [...stats.entries()].filter(([, stat]) => stat.pgrp === rootPid).map(([pid]) => pid),
  );
  const pids = new Set([...descendantsOf(rootPid, stats), ...groupPids]);
  let rssBytes = 0;
  let cpuTicks = 0;
  for (const pid of pids) {
    const stat = stats.get(pid);
    if (!stat) {
      continue;
    }
    rssBytes += stat.rssBytes;
    cpuTicks += stat.cpuTicks;
  }
  return { rssBytes, cpuTicks };
}

const started = performance.now();
const child = spawn(command, args, {
  cwd: process.cwd(),
  env: process.env,
  detached: true,
  stdio: "inherit",
});

let maxRssBytes = 0;
let maxCpuTicks = 0;
let timedOut = false;
let finished = false;
let parentSignalInFlight = false;
let forwardedParentSignal = null;
let killTimer;
let parentSignalTimer;
let parentSignalPollTimer;
let childGroupDrainTimer;
// The leader can exit before descendants in its detached process group.
// Keep the wrapper alive so timeout cleanup still owns those descendants.
let childClosedResult = null;
const updateMetrics = () => {
  if (!child.pid) {
    return;
  }
  const current = sample(child.pid);
  maxRssBytes = Math.max(maxRssBytes, current.rssBytes);
  maxCpuTicks = Math.max(maxCpuTicks, current.cpuTicks);
};

function finishChildClosedResultIfGroupDrained() {
  if (childClosedResult && !childGroupExists()) {
    finish(childClosedResult.code, childClosedResult.signal);
  }
}

// Child readiness can become externally visible before the initial /proc scan.
// Install handlers first so early parent termination still reaches the detached group.
for (const signal of ["SIGHUP", "SIGINT", "SIGTERM"]) {
  process.once(signal, () => handleParentSignal(signal));
}

updateMetrics();
const interval = setInterval(updateMetrics, pollMs);
const timeoutTimer =
  Number.isFinite(timeoutMs) && timeoutMs > 0
    ? setTimeout(() => {
        if (childClosedResult && !childGroupExists()) {
          finish(childClosedResult.code, childClosedResult.signal);
          return;
        }
        timedOut = true;
        terminateChildGroup("SIGTERM");
        killTimer = setTimeout(() => {
          terminateChildGroup("SIGKILL");
          finish(124);
        }, timeoutKillGraceMs);
        killTimer.unref?.();
      }, timeoutMs)
    : null;
timeoutTimer?.unref?.();

function terminateChildGroup(signal) {
  if (!child.pid) {
    return;
  }
  try {
    process.kill(-child.pid, signal);
    return;
  } catch {}
  try {
    child.kill(signal);
  } catch {}
}

function childGroupExists() {
  if (!child.pid) {
    return false;
  }
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (error) {
    if (error && error.code === "ESRCH") {
      return false;
    }
    return true;
  }
}

function clearRuntimeTimers() {
  clearInterval(interval);
  if (timeoutTimer) {
    clearTimeout(timeoutTimer);
  }
  if (killTimer) {
    clearTimeout(killTimer);
  }
  if (parentSignalTimer) {
    clearTimeout(parentSignalTimer);
  }
  if (parentSignalPollTimer) {
    clearInterval(parentSignalPollTimer);
  }
  if (childGroupDrainTimer) {
    clearInterval(childGroupDrainTimer);
  }
}

function rethrowParentSignal(signal) {
  clearRuntimeTimers();
  process.removeAllListeners(signal);
  process.kill(process.pid, signal);
  process.exit(128);
}

function handleParentSignal(signal) {
  if (parentSignalInFlight) {
    terminateChildGroup("SIGKILL");
    rethrowParentSignal(signal);
    return;
  }
  parentSignalInFlight = true;
  if (finished) {
    rethrowParentSignal(signal);
    return;
  }
  finished = true;
  forwardedParentSignal = signal;
  clearRuntimeTimers();
  terminateChildGroup(signal);
  parentSignalTimer = setTimeout(() => {
    terminateChildGroup("SIGKILL");
    rethrowParentSignal(signal);
  }, timeoutKillGraceMs);
  parentSignalPollTimer = setInterval(
    () => {
      if (!childGroupExists()) {
        rethrowParentSignal(signal);
      }
    },
    Math.min(50, timeoutKillGraceMs),
  );
}

process.once("exit", () => {
  if (!finished) {
    terminateChildGroup("SIGTERM");
  }
});

function finish(code, signal) {
  if (finished) {
    return;
  }
  finished = true;
  updateMetrics();
  clearRuntimeTimers();
  const wallMs = performance.now() - started;
  const cpuSeconds = maxCpuTicks / clockTicks;
  const maxRssKb = Math.round(maxRssBytes / 1024);
  const cpuCoreRatio = wallMs > 0 ? cpuSeconds / (wallMs / 1000) : 0;
  const summarySignal = timedOut ? "timeout" : (signal ?? "");
  fs.appendFileSync(
    summaryPath,
    `${phase}\t${maxRssKb}\t${cpuSeconds.toFixed(3)}\t${wallMs.toFixed(0)}\t${cpuCoreRatio.toFixed(3)}\t${summarySignal}\n`,
  );
  console.log(
    `plugin lifecycle resource: phase=${phase} max_rss_kb=${maxRssKb} cpu_s=${cpuSeconds.toFixed(3)} wall_ms=${wallMs.toFixed(0)} cpu_core_ratio=${cpuCoreRatio.toFixed(3)} signal=${summarySignal}`,
  );
  const violations = [];
  if (maxRssKb > maxRssKbThreshold) {
    violations.push(`max_rss_kb=${maxRssKb} > ${maxRssKbThreshold}`);
  }
  if (wallMs > maxWallMs) {
    violations.push(`wall_ms=${wallMs.toFixed(0)} > ${maxWallMs}`);
  }
  if (cpuCoreRatio > maxCpuCoreRatio) {
    violations.push(`cpu_core_ratio=${cpuCoreRatio.toFixed(3)} > ${maxCpuCoreRatio}`);
  }
  if (violations.length > 0) {
    console.error(
      `plugin lifecycle resource ceiling exceeded: phase=${phase} ${violations.join("; ")}`,
    );
    if (!timedOut && !signal && (code ?? 0) === 0) {
      process.exit(1);
      return;
    }
  }
  if (timedOut) {
    process.exit(124);
    return;
  }
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
}

child.on("error", (error) => {
  finished = true;
  clearRuntimeTimers();
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (parentSignalInFlight && forwardedParentSignal) {
    if (!childGroupExists()) {
      rethrowParentSignal(forwardedParentSignal);
    }
    return;
  }
  if (timedOut && killTimer) {
    return;
  }
  if (childGroupExists()) {
    childClosedResult = { code, signal };
    childGroupDrainTimer = setInterval(finishChildClosedResultIfGroupDrained, Math.min(25, pollMs));
    return;
  }
  finish(code, signal);
});
