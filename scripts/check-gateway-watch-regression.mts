#!/usr/bin/env node
// Measures gateway watch idle CPU and dist/runtime artifact churn.

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { stripLeadingPackageManagerSeparator } from "./lib/arg-utils.mts";
import {
  BUILD_STAMP_FILE,
  writeBuildStamp,
  writeRuntimePostBuildStamp,
} from "./lib/local-build-metadata.mts";
import { parseStrictNonNegativeDecimal as readNonNegativeInteger } from "./lib/numeric-options.mjs";
import { sleep } from "./lib/sleep.mjs";
import { resolveBuildRequirement } from "./run-node.mts";

const DEFAULTS = {
  outputDir: path.join(process.cwd(), ".local", "gateway-watch-regression"),
  windowMs: 10_000,
  readyTimeoutMs: 20_000,
  readySettleMs: 500,
  sigkillGraceMs: 10_000,
  sigkillExitGraceMs: 2_000,
  cpuWarnMs: 1_000,
  cpuFailMs: 8_000,
  distRuntimeFileGrowthMax: 200,
  distRuntimeByteGrowthMax: 2 * 1024 * 1024,
  keepLogs: true,
  skipBuild: false,
};

const WATCH_GATEWAY_SKIP_ENV = {
  OPENCLAW_DISABLE_BONJOUR: "1",
  OPENCLAW_SKIP_ACPX_RUNTIME: "1",
  OPENCLAW_SKIP_ACPX_RUNTIME_PROBE: "1",
  OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
  OPENCLAW_SKIP_CANVAS_HOST: "1",
  OPENCLAW_SKIP_CHANNELS: "1",
  OPENCLAW_SKIP_CRON: "1",
  OPENCLAW_SKIP_GMAIL_WATCHER: "1",
  OPENCLAW_RUNTIME_POSTBUILD_STATIC_ASSETS: "0",
  OPENCLAW_TEST_MINIMAL_GATEWAY: "1",
  NODE_ENV: "test",
};

/**
 * Maximum retained stdout/stderr text for gateway watch diagnostics.
 */
export const WATCH_LOG_CAPTURE_MAX_CHARS = 2 * 1024 * 1024;
export const WATCH_LOG_FAILURE_TAIL_CHARS = 12_000;
const WATCH_BUILD_DETECTION_MAX_CHARS = 4096;
const ANSI_ESCAPE_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, "g");

type WatchOptions = typeof DEFAULTS;
type WatchExit = {
  code: number | null;
  signal: string | null;
  error?: string;
};
type WatchBuildDetectionState = {
  buffer?: string;
  triggered?: boolean;
  reason?: string | null;
};
type TreeSnapshot = {
  exists: boolean;
  files: number;
  directories: number;
  symlinks: number;
  entries: number;
  apparentBytes: number;
};
type Timing = { userSeconds: number; sysSeconds: number; elapsedSeconds: number };
type WatchSignal = "SIGKILL" | "SIGTERM";
type WatchStream = {
  destroy?: unknown;
  on?(event: "data", listener: (chunk: Uint8Array | string) => void): unknown;
};
type SpawnedWatchChild = {
  exitCode?: number | null;
  once(event: "error", listener: (error: Error) => void): unknown;
  once(event: "exit", listener: (code: number | null, signal: string | null) => void): unknown;
  signalCode?: string | null;
  stderr?: WatchStream | null;
  stdin?: WatchStream | null;
  stdout?: WatchStream | null;
  unref?: unknown;
};
type TimedWatchOptions = Pick<
  WatchOptions,
  "readySettleMs" | "readyTimeoutMs" | "sigkillGraceMs" | "windowMs"
> &
  Partial<Pick<WatchOptions, "sigkillExitGraceMs">>;
type WatchSpawnOptions = {
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdio: ["ignore", "pipe", "pipe"];
};
type TimedWatchResult = {
  exit: WatchExit | null;
  spawnError: string | null;
  timingFileMissing: boolean;
  timing: Timing;
  readyBeforeWindow: boolean;
  exitedBeforeReady: boolean;
  exitedBeforeStop: boolean;
  idleCpuMs: number | null;
  stdoutPath: string;
  stderrPath: string;
  timeFilePath: string;
  watchTriggeredBuild: boolean;
  watchBuildReason: string | null;
};
type TimedWatchDeps = {
  allocateLoopbackPort?: () => Promise<number>;
  parseTimingFile?: (filePath: string) => Timing;
  readProcessTreeCpuMs?: (pid: number) => number | null;
  sleep?: (ms: number) => Promise<void>;
  spawn?: (command: string, args: string[], options: WatchSpawnOptions) => SpawnedWatchChild;
  stopTimedWatchChild?: (
    child: SpawnedWatchChild,
    watchPid: number | null,
    options: TimedWatchOptions,
  ) => Promise<WatchExit>;
  waitForGatewayReady?: (readText: () => string, timeoutMs: number) => Promise<boolean>;
};
type BuildRequirementSummary = { shouldBuild?: boolean; reason?: string };
type WatchFindingResult = {
  exit?: WatchExit | null;
  exitedBeforeReady?: boolean;
  exitedBeforeStop?: boolean;
  idleCpuMs?: number | null;
  readyBeforeWindow: boolean;
  spawnError: string | null;
  timingFileMissing: boolean;
};

function shellQuote(value: unknown): string {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

/**
 * Appends watch output while preserving only the diagnostic tail.
 */
export function appendBoundedWatchLog(
  current: string,
  chunk: string | Uint8Array,
  maxChars = WATCH_LOG_CAPTURE_MAX_CHARS,
) {
  const next = current + chunk.toString();
  if (next.length <= maxChars) {
    return { text: next, truncated: false };
  }
  return { text: next.slice(-maxChars), truncated: true };
}

function formatCapturedWatchLog(text: string, truncated: boolean): string {
  return truncated
    ? `[openclaw] log truncated to last ${WATCH_LOG_CAPTURE_MAX_CHARS} chars\n${text}`
    : text;
}

function formatWatchExit(exit: WatchExit | null | undefined): string {
  if (!exit) {
    return "unknown exit";
  }
  const parts: string[] = [];
  if (exit.code !== undefined) {
    parts.push(`code ${exit.code === null ? "null" : exit.code}`);
  }
  if (exit.signal !== undefined) {
    parts.push(`signal ${exit.signal === null ? "null" : exit.signal}`);
  }
  if (exit.error) {
    parts.push(`error ${exit.error}`);
  }
  return parts.length > 0 ? parts.join(", ") : "unknown exit";
}

function readTextTail(filePath: string, maxChars = WATCH_LOG_FAILURE_TAIL_CHARS): string {
  const text = fs.readFileSync(filePath, "utf8");
  return text.length <= maxChars ? text : text.slice(-maxChars);
}

/**
 * Updates bounded watch-build detection state from new output.
 */
export function updateWatchBuildDetection(
  state: WatchBuildDetectionState,
  chunk: unknown,
): { buffer: string; triggered: boolean; reason: string | null } {
  const combined = `${state.buffer ?? ""}${String(chunk)}`;
  const next = appendBoundedWatchLog("", combined, WATCH_BUILD_DETECTION_MAX_CHARS);
  const reason = detectWatchBuildReason(combined, "");
  const triggered = state.triggered || combined.includes("Building TypeScript (dist is stale");
  return {
    buffer: next.text,
    triggered,
    reason: state.reason ?? reason,
  };
}

/**
 * Parses gateway watch regression CLI arguments.
 */
export function parseArgs(argv: string[]): WatchOptions {
  const args = stripLeadingPackageManagerSeparator(argv);
  const options = { ...DEFAULTS };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    const next = args[i + 1];
    const readValue = () => {
      if (!next) {
        throw new Error(`Missing value for ${arg}`);
      }
      i += 1;
      return next;
    };
    switch (arg) {
      case "--output-dir":
        options.outputDir = path.resolve(readValue());
        break;
      case "--window-ms":
        options.windowMs = readNonNegativeInteger(readValue(), "--window-ms");
        break;
      case "--ready-timeout-ms":
        options.readyTimeoutMs = readNonNegativeInteger(readValue(), "--ready-timeout-ms");
        break;
      case "--ready-settle-ms":
        options.readySettleMs = readNonNegativeInteger(readValue(), "--ready-settle-ms");
        break;
      case "--sigkill-grace-ms":
        options.sigkillGraceMs = readNonNegativeInteger(readValue(), "--sigkill-grace-ms");
        break;
      case "--sigkill-exit-grace-ms":
        options.sigkillExitGraceMs = readNonNegativeInteger(readValue(), "--sigkill-exit-grace-ms");
        break;
      case "--cpu-warn-ms":
        options.cpuWarnMs = readNonNegativeInteger(readValue(), "--cpu-warn-ms");
        break;
      case "--cpu-fail-ms":
        options.cpuFailMs = readNonNegativeInteger(readValue(), "--cpu-fail-ms");
        break;
      case "--dist-runtime-file-growth-max":
        options.distRuntimeFileGrowthMax = readNonNegativeInteger(
          readValue(),
          "--dist-runtime-file-growth-max",
        );
        break;
      case "--dist-runtime-byte-growth-max":
        options.distRuntimeByteGrowthMax = readNonNegativeInteger(
          readValue(),
          "--dist-runtime-byte-growth-max",
        );
        break;
      case "--skip-build":
        options.skipBuild = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function ensureDir(dirPath: string) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function removePathIfExists(targetPath: string) {
  fs.rmSync(targetPath, { recursive: true, force: true });
}

function lstatIfExists(targetPath: string): {
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
  size: number;
} | null {
  try {
    return fs.lstatSync(targetPath);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function normalizePath(filePath: string): string {
  return filePath.replaceAll("\\", "/");
}

function listTreeEntries(rootName: string): string[] {
  const rootPath = path.join(process.cwd(), rootName);
  if (!fs.existsSync(rootPath)) {
    return [`${rootName} (missing)`];
  }

  const entries = [rootName];
  const queue = [rootPath];
  while (queue.length > 0) {
    const current = queue.pop();
    if (!current) {
      continue;
    }
    let dirents;
    try {
      dirents = fs.readdirSync(current, { withFileTypes: true });
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        continue;
      }
      throw error;
    }
    for (const dirent of dirents) {
      const fullPath = path.join(current, dirent.name);
      const relativePath = normalizePath(path.relative(process.cwd(), fullPath));
      entries.push(relativePath);
      if (dirent.isDirectory()) {
        queue.push(fullPath);
      }
    }
  }
  return entries.toSorted((a, b) => a.localeCompare(b));
}

function humanBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes}B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)}K`;
  }
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
  }
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}G`;
}

function snapshotTree(rootName: string): TreeSnapshot {
  const rootPath = path.join(process.cwd(), rootName);
  const stats = {
    exists: fs.existsSync(rootPath),
    files: 0,
    directories: 0,
    symlinks: 0,
    entries: 0,
    apparentBytes: 0,
  };

  if (!stats.exists) {
    return stats;
  }

  const queue = [rootPath];
  while (queue.length > 0) {
    const current = queue.pop();
    if (!current) {
      continue;
    }
    const currentStats = lstatIfExists(current);
    if (!currentStats) {
      continue;
    }
    stats.entries += 1;
    if (currentStats.isDirectory()) {
      stats.directories += 1;
      for (const dirent of fs.readdirSync(current, { withFileTypes: true })) {
        queue.push(path.join(current, dirent.name));
      }
      continue;
    }
    if (currentStats.isSymbolicLink()) {
      stats.symlinks += 1;
      continue;
    }
    if (currentStats.isFile()) {
      stats.files += 1;
      stats.apparentBytes += currentStats.size;
    }
  }

  return stats;
}

function writeSnapshot(snapshotDir: string): {
  generatedAt: string;
  dist: TreeSnapshot;
  distRuntime: TreeSnapshot;
} {
  ensureDir(snapshotDir);
  const pathEntries = [...listTreeEntries("dist"), ...listTreeEntries("dist-runtime")];
  fs.writeFileSync(path.join(snapshotDir, "paths.txt"), `${pathEntries.join("\n")}\n`, "utf8");

  const dist = snapshotTree("dist");
  const distRuntime = snapshotTree("dist-runtime");
  const snapshot = {
    generatedAt: new Date().toISOString(),
    dist,
    distRuntime,
  };
  fs.writeFileSync(
    path.join(snapshotDir, "snapshot.json"),
    `${JSON.stringify(snapshot, null, 2)}\n`,
  );
  fs.writeFileSync(
    path.join(snapshotDir, "stats.txt"),
    [
      `generated_at: ${snapshot.generatedAt}`,
      "",
      "[dist]",
      `files: ${dist.files}`,
      `directories: ${dist.directories}`,
      `symlinks: ${dist.symlinks}`,
      `entries: ${dist.entries}`,
      `apparent_bytes: ${dist.apparentBytes}`,
      `apparent_human: ${humanBytes(dist.apparentBytes)}`,
      "",
      "[dist-runtime]",
      `files: ${distRuntime.files}`,
      `directories: ${distRuntime.directories}`,
      `symlinks: ${distRuntime.symlinks}`,
      `entries: ${distRuntime.entries}`,
      `apparent_bytes: ${distRuntime.apparentBytes}`,
      `apparent_human: ${humanBytes(distRuntime.apparentBytes)}`,
      "",
    ].join("\n"),
    "utf8",
  );
  return snapshot;
}

function runCheckedCommand(command: string, args: string[]) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    stdio: "inherit",
    env: process.env,
  });
  if (typeof result.status === "number" && result.status === 0) {
    return;
  }
  throw new Error(`${command} ${args.join(" ")} failed with status ${result.status ?? "unknown"}`);
}

function parsePsCpuTimeMs(timeText: string): number | null {
  const [maybeDays, clockText] = timeText.includes("-") ? timeText.split("-", 2) : ["0", timeText];
  const days = Number(maybeDays);
  const parts = clockText!.split(":");
  if (!Number.isFinite(days) || parts.length < 2 || parts.length > 3) {
    return null;
  }
  const seconds = Number(parts.at(-1));
  const minutes = Number(parts.at(-2));
  const hours = parts.length === 3 ? Number(parts[0]) : 0;
  if (![seconds, minutes, hours].every(Number.isFinite)) {
    return null;
  }
  return Math.round(((days * 24 + hours) * 60 * 60 + minutes * 60 + seconds) * 1000);
}

function readProcessTreeCpuMs(rootPid: number): number | null {
  if (!Number.isInteger(rootPid) || rootPid <= 0) {
    return null;
  }
  const result = spawnSync("ps", ["-eo", "pid=,ppid=,time="], {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0) {
    return null;
  }

  const rows: Array<{ pid: number; ppid: number; cpuMs: number }> = [];
  for (const line of result.stdout.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)$/);
    if (!match) {
      continue;
    }
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    const cpuMs = parsePsCpuTimeMs(match[3]!);
    if (!Number.isInteger(pid) || !Number.isInteger(ppid) || cpuMs == null) {
      continue;
    }
    rows.push({ pid, ppid, cpuMs });
  }

  const childrenByParent = new Map<number, number[]>();
  const cpuByPid = new Map<number, number>();
  for (const row of rows) {
    cpuByPid.set(row.pid, row.cpuMs);
    const children = childrenByParent.get(row.ppid) ?? [];
    children.push(row.pid);
    childrenByParent.set(row.ppid, children);
  }
  if (!cpuByPid.has(rootPid)) {
    return null;
  }

  let totalCpuMs = 0;
  const seen = new Set<number>();
  const stack = [rootPid];
  while (stack.length > 0) {
    const pid = stack.pop();
    if (!pid || seen.has(pid)) {
      continue;
    }
    seen.add(pid);
    totalCpuMs += cpuByPid.get(pid) ?? 0;
    for (const childPid of childrenByParent.get(pid) ?? []) {
      stack.push(childPid);
    }
  }
  return totalCpuMs;
}

/**
 * Reports whether gateway watch output contains a ready marker.
 */
export function hasGatewayReadyLog(text: string): boolean {
  const normalized = text.replaceAll(ANSI_ESCAPE_PATTERN, "");
  return /\[gateway\] (?:http server listening|ready(?:\b|\s*\())/.test(normalized);
}

async function waitForGatewayReady(readText: () => string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (hasGatewayReadyLog(readText())) {
      return true;
    }
    await sleep(100);
  }
  return false;
}

async function allocateLoopbackPort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to allocate watch regression port")));
        return;
      }
      const { port } = address;
      server.close((closeErr) => {
        if (closeErr) {
          reject(closeErr instanceof Error ? closeErr : new Error(String(closeErr)));
          return;
        }
        resolve(port);
      });
    });
  });
}

export function resolveTimedWatchShell(
  deps: { existsSync?: (filePath: string) => boolean } = {},
): string {
  const existsSync = deps.existsSync ?? fs.existsSync;
  for (const shellPath of ["/bin/bash", "/usr/bin/bash", "/bin/sh"]) {
    if (existsSync(shellPath)) {
      return shellPath;
    }
  }
  return "/bin/sh";
}

export function buildTimedWatchCommand(
  pidFilePath: string,
  timeFilePath: string,
  isolatedHomeDir: string,
  port: number,
  deps: {
    existsSync?: (filePath: string) => boolean;
    shellPath?: string;
    nodeExecPath?: string;
  } = {},
) {
  const isolatedStateDir = path.join(isolatedHomeDir, ".openclaw");
  const isolatedConfigPath = path.join(isolatedStateDir, "openclaw.json");
  // CI env hooks can contain bash-only `declare` lines; running the watch shell
  // under sh delays gateway readiness behind stderr noise before the idle window.
  const shellPath = deps.shellPath ?? resolveTimedWatchShell(deps);
  const nodeExecPath = deps.nodeExecPath ?? process.execPath;
  const shellSource = [
    'echo "$$" > "$OPENCLAW_WATCH_PID_FILE"',
    'mkdir -p "$OPENCLAW_STATE_DIR"',
    `printf '%s\n' '{"gateway":{"controlUi":{"enabled":false}},"plugins":{"enabled":false}}' > "$OPENCLAW_CONFIG_PATH"`,
    `exec ${shellQuote(nodeExecPath)} scripts/watch-node.mjs gateway --force --allow-unconfigured --port ${String(port)} --token watch-regression-token`,
  ].join("\n");
  const nodeBinDir = path.dirname(nodeExecPath);
  const env = {
    OPENCLAW_WATCH_PID_FILE: pidFilePath,
    HOME: isolatedHomeDir,
    OPENCLAW_HOME: isolatedHomeDir,
    OPENCLAW_CONFIG_PATH: isolatedConfigPath,
    OPENCLAW_STATE_DIR: isolatedStateDir,
    PATH: `${nodeBinDir}${path.delimiter}${process.env.PATH ?? ""}`,
    XDG_CONFIG_HOME: path.join(isolatedHomeDir, ".config"),
    ...WATCH_GATEWAY_SKIP_ENV,
  };

  if (process.platform === "darwin") {
    return {
      command: "/usr/bin/time",
      args: ["-lp", "-o", timeFilePath, shellPath, "-lc", shellSource],
      env,
    };
  }

  if (!fs.existsSync("/usr/bin/time")) {
    return {
      command: shellPath,
      args: ["-lc", shellSource],
      env,
    };
  }

  return {
    command: "/usr/bin/time",
    args: [
      "-f",
      "__TIMING__ user=%U sys=%S elapsed=%e",
      "-o",
      timeFilePath,
      shellPath,
      "-lc",
      shellSource,
    ],
    env,
  };
}

function parseTimingFile(timeFilePath: string): Timing {
  const text = fs.readFileSync(timeFilePath, "utf8");
  if (process.platform === "darwin") {
    const user = Number(text.match(/^user\s+([0-9.]+)/m)?.[1] ?? "NaN");
    const sys = Number(text.match(/^sys\s+([0-9.]+)/m)?.[1] ?? "NaN");
    const elapsed = Number(text.match(/^real\s+([0-9.]+)/m)?.[1] ?? "NaN");
    return {
      userSeconds: user,
      sysSeconds: sys,
      elapsedSeconds: elapsed,
    };
  }

  const match = text.match(/__TIMING__ user=([0-9.]+) sys=([0-9.]+) elapsed=([0-9.]+)/);
  return {
    userSeconds: Number(match?.[1] ?? "NaN"),
    sysSeconds: Number(match?.[2] ?? "NaN"),
    elapsedSeconds: Number(match?.[3] ?? "NaN"),
  };
}

/**
 * Runs a bounded gateway watch process and captures timing/log artifacts.
 */
export async function runTimedWatch(
  options: TimedWatchOptions,
  outputDir: string,
  deps: TimedWatchDeps = {},
): Promise<TimedWatchResult> {
  const allocatePort = deps.allocateLoopbackPort ?? allocateLoopbackPort;
  const parseTiming = deps.parseTimingFile ?? parseTimingFile;
  const readCpuMs = deps.readProcessTreeCpuMs ?? readProcessTreeCpuMs;
  const sleepMs = deps.sleep ?? sleep;
  const spawnCommand: NonNullable<TimedWatchDeps["spawn"]> =
    deps.spawn ?? ((command, args, spawnOptions) => spawn(command, args, spawnOptions));
  const stopChild = deps.stopTimedWatchChild ?? stopTimedWatchChild;
  const waitReady = deps.waitForGatewayReady ?? waitForGatewayReady;
  const pidFilePath = path.join(outputDir, "watch.pid");
  const timeFilePath = path.join(outputDir, "watch.time.log");
  const isolatedHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-gateway-watch-"));
  fs.writeFileSync(path.join(outputDir, "watch.home.txt"), `${isolatedHomeDir}\n`, "utf8");
  try {
    const stdoutPath = path.join(outputDir, "watch.stdout.log");
    const stderrPath = path.join(outputDir, "watch.stderr.log");
    for (const stalePath of [pidFilePath, timeFilePath, stdoutPath, stderrPath]) {
      removePathIfExists(stalePath);
    }
    const port = await allocatePort();
    fs.writeFileSync(path.join(outputDir, "watch.port.txt"), `${String(port)}\n`, "utf8");
    const { command, args, env } = buildTimedWatchCommand(
      pidFilePath,
      timeFilePath,
      isolatedHomeDir,
      port,
    );
    const child = spawnCommand(command, args, {
      cwd: process.cwd(),
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let buildDetection: Required<WatchBuildDetectionState> = {
      buffer: "",
      triggered: false,
      reason: null,
    };
    child.stdout?.on?.("data", (chunk) => {
      const next = appendBoundedWatchLog(stdout, chunk);
      stdout = next.text;
      stdoutTruncated ||= next.truncated;
      buildDetection = updateWatchBuildDetection(buildDetection, chunk);
    });
    child.stderr?.on?.("data", (chunk) => {
      const next = appendBoundedWatchLog(stderr, chunk);
      stderr = next.text;
      stderrTruncated ||= next.truncated;
      buildDetection = updateWatchBuildDetection(buildDetection, chunk);
    });

    let spawnErrorMessage: string | null = null;
    const spawnErrorExit = new Promise<WatchExit>((resolve) => {
      child.once("error", (error) => {
        spawnErrorMessage = error.message;
        resolve({ code: null, signal: null, error: error.message });
      });
    });
    const childExit = new Promise<WatchExit>((resolve) => {
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    const raceChildLifecycle = async <Value,>(operation: Value | PromiseLike<Value>) =>
      await Promise.race([
        Promise.resolve(operation).then((value) => ({ type: "value" as const, value })),
        spawnErrorExit.then((value) => ({ type: "spawn-error" as const, value })),
        childExit.then((value) => ({ type: "child-exit" as const, value })),
      ]);

    let watchPid: number | null = null;
    let exit: WatchExit | null = null;
    let exitedBeforeReady = false;
    let exitedBeforeStop = false;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (fs.existsSync(pidFilePath)) {
        watchPid = Number(fs.readFileSync(pidFilePath, "utf8").trim());
        break;
      }
      const waitResult = await raceChildLifecycle(sleepMs(100));
      if (waitResult.type === "spawn-error") {
        exit = waitResult.value;
        break;
      }
      if (waitResult.type === "child-exit") {
        exit = waitResult.value;
        exitedBeforeReady = true;
        exitedBeforeStop = true;
        break;
      }
    }

    let readyBeforeWindow = false;
    let idleCpuStartMs: number | null = null;
    let idleCpuEndMs: number | null = null;
    if (!exit) {
      const readyResult = await raceChildLifecycle(
        waitReady(() => `${stdout}\n${stderr}`, options.readyTimeoutMs),
      );
      if (readyResult.type === "spawn-error") {
        exit = readyResult.value;
      } else if (readyResult.type === "child-exit") {
        exit = readyResult.value;
        exitedBeforeReady = true;
        exitedBeforeStop = true;
      } else {
        readyBeforeWindow = readyResult.value;
      }
    }
    if (!exit && readyBeforeWindow && options.readySettleMs > 0) {
      const settleResult = await raceChildLifecycle(sleepMs(options.readySettleMs));
      if (settleResult.type === "spawn-error") {
        exit = settleResult.value;
      } else if (settleResult.type === "child-exit") {
        exit = settleResult.value;
        exitedBeforeStop = true;
      }
    }
    if (!exit) {
      idleCpuStartMs = watchPid ? readCpuMs(watchPid) : null;
      const windowResult = await raceChildLifecycle(sleepMs(options.windowMs));
      if (windowResult.type === "spawn-error") {
        exit = windowResult.value;
      } else if (windowResult.type === "child-exit") {
        exit = windowResult.value;
        exitedBeforeStop = true;
      } else {
        idleCpuEndMs = watchPid ? readCpuMs(watchPid) : null;
      }
    }
    if (!exit) {
      const stopResult = await raceChildLifecycle(stopChild(child, watchPid, options));
      exit = stopResult.value as WatchExit;
    }

    fs.writeFileSync(stdoutPath, formatCapturedWatchLog(stdout, stdoutTruncated), "utf8");
    fs.writeFileSync(stderrPath, formatCapturedWatchLog(stderr, stderrTruncated), "utf8");
    const timingFileMissing = !fs.existsSync(timeFilePath);
    const timing = timingFileMissing
      ? { userSeconds: Number.NaN, sysSeconds: Number.NaN, elapsedSeconds: Number.NaN }
      : parseTiming(timeFilePath);

    return {
      exit,
      spawnError: spawnErrorMessage,
      timingFileMissing,
      timing,
      readyBeforeWindow,
      exitedBeforeReady,
      exitedBeforeStop,
      idleCpuMs:
        idleCpuStartMs == null || idleCpuEndMs == null
          ? null
          : Math.max(0, idleCpuEndMs - idleCpuStartMs),
      stdoutPath,
      stderrPath,
      timeFilePath,
      watchTriggeredBuild: buildDetection.triggered,
      watchBuildReason: buildDetection.reason,
    };
  } finally {
    fs.rmSync(isolatedHomeDir, { force: true, recursive: true });
  }
}

/**
 * Stops the timed watch child process with TERM/KILL fallback.
 */
export async function stopTimedWatchChild(
  child: SpawnedWatchChild,
  watchPid: number | null,
  options: Pick<WatchOptions, "sigkillGraceMs"> & Partial<Pick<WatchOptions, "sigkillExitGraceMs">>,
  deps: { killProcess?: (pid: number, signal: WatchSignal) => unknown } = {},
): Promise<WatchExit> {
  const killProcess =
    deps.killProcess ?? ((pid: number, signal: WatchSignal) => process.kill(pid, signal));
  const currentExit = (): WatchExit | null => {
    const code = child.exitCode;
    const signal = child.signalCode;
    return typeof code === "number" || typeof signal === "string"
      ? { code: code ?? null, signal: signal ?? null }
      : null;
  };
  const exited = new Promise<WatchExit>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  const waitForExit = async (ms: number): Promise<WatchExit | null> =>
    currentExit() ?? (await Promise.race([exited, sleep(ms).then(() => null)]));
  const signalWatchProcess = (signal: WatchSignal) => {
    if (!watchPid) {
      return;
    }
    try {
      killProcess(watchPid, signal);
    } catch {
      // ignore
    }
  };

  const existingExit = currentExit();
  if (existingExit) {
    return existingExit;
  }

  signalWatchProcess("SIGTERM");
  const gracefulExit = await waitForExit(options.sigkillGraceMs);
  if (gracefulExit) {
    return gracefulExit;
  }

  signalWatchProcess("SIGKILL");
  const killedExit = await waitForExit(options.sigkillExitGraceMs ?? DEFAULTS.sigkillExitGraceMs);
  if (killedExit) {
    return killedExit;
  }

  releaseUnsettledWatchChild(child);
  return { code: null, signal: "SIGKILL" };
}

function releaseUnsettledWatchChild(child: SpawnedWatchChild) {
  for (const stream of [child.stdin, child.stdout, child.stderr]) {
    if (typeof stream?.destroy === "function") {
      stream.destroy();
    }
  }
  if (typeof child.unref === "function") {
    child.unref();
  }
}

function parsePathFile(filePath: string): string[] {
  return fs
    .readFileSync(filePath, "utf8")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean);
}

function writeDiffArtifacts(outputDir: string, preDir: string, postDir: string) {
  const diffDir = path.join(outputDir, "diff");
  ensureDir(diffDir);
  const prePaths = parsePathFile(path.join(preDir, "paths.txt"));
  const postPaths = parsePathFile(path.join(postDir, "paths.txt"));
  const preSet = new Set(prePaths);
  const postSet = new Set(postPaths);
  const added = postPaths.filter((entry) => !preSet.has(entry));
  const removed = prePaths.filter((entry) => !postSet.has(entry));

  fs.writeFileSync(path.join(diffDir, "added-paths.txt"), `${added.join("\n")}\n`, "utf8");
  fs.writeFileSync(path.join(diffDir, "removed-paths.txt"), `${removed.join("\n")}\n`, "utf8");
  return { added, removed };
}

function fail(message: string) {
  console.error(`FAIL: ${message}`);
}

function warn(message: string) {
  console.error(`WARN: ${message}`);
}

function detectWatchBuildReason(stdout: string, stderr: string): string | null {
  const combined = `${stdout}\n${stderr}`;
  const match = combined.match(/Building TypeScript \(dist is stale: ([a-z_]+)/);
  return match?.[1] ?? null;
}

function buildRunNodeDeps(env: NodeJS.ProcessEnv) {
  const cwd = process.cwd();
  return {
    cwd,
    env,
    fs,
    spawnSync,
    distRoot: path.join(cwd, "dist"),
    distEntry: path.join(cwd, "dist", "/entry.js"),
    buildStampPath: path.join(cwd, "dist", BUILD_STAMP_FILE),
    sourceRoots: ["src", "extensions"].map((sourceRoot) => ({
      name: sourceRoot,
      path: path.join(cwd, sourceRoot),
    })),
    configFiles: ["tsconfig.json", "package.json", "tsdown.config.ts"].map((filePath) =>
      path.join(cwd, filePath),
    ),
  };
}

/**
 * Reports whether restored CI artifacts need fresh build stamps.
 */
export function shouldRefreshBuildStampForRestoredArtifacts(params: {
  skipBuild?: boolean;
  buildRequirement?: BuildRequirementSummary;
}): boolean {
  return (
    params.skipBuild === true &&
    params.buildRequirement?.shouldBuild === true &&
    params.buildRequirement.reason === "config_newer"
  );
}

/**
 * Writes build and runtime-postbuild stamps for the current artifact set.
 */
export function writeBuildAndRuntimePostBuildStamps(params: { cwd?: string } = {}) {
  const cwd = params.cwd ?? process.cwd();
  writeBuildStamp({ cwd });
  writeRuntimePostBuildStamp({ cwd });
}

/**
 * Collects pass/fail findings for the bounded gateway watch regression run.
 */
export function collectGatewayWatchFindings(params: {
  cpuMs: number;
  distRuntimeByteGrowth: number;
  distRuntimeFileGrowth: number;
  options: Pick<
    WatchOptions,
    "cpuFailMs" | "cpuWarnMs" | "distRuntimeByteGrowthMax" | "distRuntimeFileGrowthMax" | "windowMs"
  >;
  watchBuildReason: string | null;
  watchResult: WatchFindingResult;
  watchTriggeredBuild: boolean;
}): { failures: string[]; warnings: string[] } {
  const {
    cpuMs,
    distRuntimeByteGrowth,
    distRuntimeFileGrowth,
    options,
    watchBuildReason,
    watchResult,
    watchTriggeredBuild,
  } = params;
  const failures: string[] = [];
  const warnings: string[] = [];
  if (watchResult.spawnError) {
    failures.push(`gateway:watch failed to start: ${watchResult.spawnError}`);
  }
  if (!watchResult.readyBeforeWindow && watchResult.exitedBeforeReady) {
    failures.push(`gateway:watch exited before ready (${formatWatchExit(watchResult.exit)})`);
  } else if (!watchResult.readyBeforeWindow) {
    failures.push("gateway:watch did not report ready before the idle CPU window");
  }
  if (watchResult.readyBeforeWindow && watchResult.exitedBeforeStop) {
    failures.push(
      `gateway:watch exited before the idle CPU window completed (${formatWatchExit(watchResult.exit)})`,
    );
  }
  if (watchResult.timingFileMissing && !Number.isFinite(watchResult.idleCpuMs)) {
    failures.push(
      "failed to collect CPU timing from the bounded gateway:watch run; timing artifact is missing",
    );
  } else if (watchResult.timingFileMissing) {
    warnings.push(
      "bounded gateway:watch timing artifact is missing; using process-tree idle CPU sample",
    );
  }
  if (watchTriggeredBuild && watchBuildReason === "dirty_watched_tree") {
    failures.push(
      "gateway:watch invalid local run: dirty watched source tree forced a rebuild during the watch window",
    );
  }
  if (distRuntimeFileGrowth > options.distRuntimeFileGrowthMax) {
    failures.push(
      `dist-runtime file growth ${distRuntimeFileGrowth} exceeded max ${options.distRuntimeFileGrowthMax}`,
    );
  }
  if (distRuntimeByteGrowth > options.distRuntimeByteGrowthMax) {
    failures.push(
      `dist-runtime apparent byte growth ${distRuntimeByteGrowth} exceeded max ${options.distRuntimeByteGrowthMax}`,
    );
  }
  if (!Number.isFinite(cpuMs)) {
    failures.push("failed to parse CPU timing from the bounded gateway:watch run");
  } else if (cpuMs > options.cpuFailMs) {
    failures.push(
      `LOUD ALARM: gateway:watch used ${cpuMs}ms CPU in ${options.windowMs}ms window, above loud-alarm threshold ${options.cpuFailMs}ms`,
    );
  } else if (cpuMs > options.cpuWarnMs) {
    warnings.push(
      `gateway:watch used ${cpuMs}ms CPU in ${options.windowMs}ms window, above target ${options.cpuWarnMs}ms`,
    );
  }
  return { failures, warnings };
}

export function shouldReportDuplicateDistRuntimeRegression(failures: string[]): boolean {
  return failures.some((message) => message.startsWith("dist-runtime "));
}

function printWatchLogDiagnostics(watchResult: TimedWatchResult) {
  const artifacts: Array<[string, string]> = [
    ["stderr", watchResult.stderrPath],
    ["stdout", watchResult.stdoutPath],
  ];
  for (const [label, filePath] of artifacts) {
    if (!filePath || !fs.existsSync(filePath)) {
      continue;
    }
    const tail = readTextTail(filePath).trimEnd();
    if (!tail) {
      warn(`gateway:watch ${label} artifact is empty (${filePath})`);
      continue;
    }
    console.error(
      `--- gateway:watch ${label} tail (${filePath}, last ${WATCH_LOG_FAILURE_TAIL_CHARS} chars) ---`,
    );
    console.error(tail);
    console.error(`--- end gateway:watch ${label} tail ---`);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  ensureDir(options.outputDir);
  if (!options.skipBuild) {
    runCheckedCommand("node", ["--import", "tsx", "scripts/build-all.mts", "gatewayWatch"]);
    // The watch harness must start from a completed dist/runtime baseline.
    // Refresh both stamps after the gateway build finishes so run-node does not
    // leave stale local artifact metadata after the bounded watch window.
    writeBuildAndRuntimePostBuildStamps();
  } else {
    // Restored CI artifacts can be older than the fresh checkout mtimes.
    // Refresh the local artifact stamps so run-node trusts the already-built dist.
    writeBuildAndRuntimePostBuildStamps();
  }

  let preflightBuildRequirement = resolveBuildRequirement(buildRunNodeDeps(process.env));
  if (
    shouldRefreshBuildStampForRestoredArtifacts({
      skipBuild: options.skipBuild,
      buildRequirement: preflightBuildRequirement,
    })
  ) {
    // CI's skip-build path restores a built dist artifact after checkout.
    // Refresh the stamps so checkout mtimes for package/config files do not
    // force a duplicate build during the bounded gateway:watch window.
    writeBuildAndRuntimePostBuildStamps();
    preflightBuildRequirement = resolveBuildRequirement(buildRunNodeDeps(process.env));
  }
  if (
    preflightBuildRequirement.shouldBuild &&
    preflightBuildRequirement.reason === "dirty_watched_tree"
  ) {
    const summary = {
      windowMs: options.windowMs,
      invalidated: true,
      invalidationReason: preflightBuildRequirement.reason,
      invalidationMessage:
        "gateway-watch-regression cannot run on a dirty watched tree because run-node will intentionally rebuild during the watch window.",
    };
    fs.writeFileSync(
      path.join(options.outputDir, "summary.json"),
      `${JSON.stringify(summary, null, 2)}\n`,
    );
    console.log(JSON.stringify(summary, null, 2));
    fail(
      "gateway-watch-regression invalid local run: dirty watched source tree would force a rebuild inside the watch window",
    );
    process.exit(1);
  }

  const preDir = path.join(options.outputDir, "pre");
  const pre = writeSnapshot(preDir);

  const watchDir = path.join(options.outputDir, "watch");
  ensureDir(watchDir);
  const watchResult = await runTimedWatch(options, watchDir);

  const postDir = path.join(options.outputDir, "post");
  const post = writeSnapshot(postDir);
  const diff = writeDiffArtifacts(options.outputDir, preDir, postDir);

  const distRuntimeAddedPaths = diff.added.filter((entry) =>
    entry.startsWith("dist-runtime/"),
  ).length;
  const distRuntimeFileGrowth = distRuntimeAddedPaths;
  const distRuntimeByteGrowth =
    distRuntimeAddedPaths === 0
      ? 0
      : post.distRuntime.apparentBytes - pre.distRuntime.apparentBytes;
  const totalCpuMs = Math.round(
    (watchResult.timing.userSeconds + watchResult.timing.sysSeconds) * 1000,
  );
  const cpuMs = watchResult.idleCpuMs ?? totalCpuMs;
  const watchTriggeredBuild = watchResult.watchTriggeredBuild;
  const watchBuildReason = watchResult.watchBuildReason;

  const summary = {
    windowMs: options.windowMs,
    watchTriggeredBuild,
    watchBuildReason,
    cpuMs,
    totalCpuMs,
    readyBeforeWindow: watchResult.readyBeforeWindow,
    exitedBeforeReady: watchResult.exitedBeforeReady,
    exitedBeforeStop: watchResult.exitedBeforeStop,
    cpuWarnMs: options.cpuWarnMs,
    cpuFailMs: options.cpuFailMs,
    distRuntimeFileGrowth,
    distRuntimeFileGrowthMax: options.distRuntimeFileGrowthMax,
    distRuntimeByteGrowth,
    distRuntimeByteGrowthMax: options.distRuntimeByteGrowthMax,
    distRuntimeAddedPaths,
    addedPaths: diff.added.length,
    removedPaths: diff.removed.length,
    watchExit: watchResult.exit,
    spawnError: watchResult.spawnError,
    stdoutPath: watchResult.stdoutPath,
    stderrPath: watchResult.stderrPath,
    timingFileMissing: watchResult.timingFileMissing,
    timing: watchResult.timing,
  };
  fs.writeFileSync(
    path.join(options.outputDir, "summary.json"),
    `${JSON.stringify(summary, null, 2)}\n`,
  );

  console.log(JSON.stringify(summary, null, 2));

  const { failures, warnings } = collectGatewayWatchFindings({
    cpuMs,
    distRuntimeByteGrowth,
    distRuntimeFileGrowth,
    options,
    watchBuildReason,
    watchResult,
    watchTriggeredBuild,
  });

  for (const message of warnings) {
    warn(message);
  }

  if (failures.length > 0) {
    for (const message of failures) {
      fail(message);
    }
    printWatchLogDiagnostics(watchResult);
    if (shouldReportDuplicateDistRuntimeRegression(failures)) {
      fail(
        "Possible duplicate dist-runtime graph regression: this can reintroduce split runtime personalities where plugins and core observe different global state, including Telegram missing /voice, /phone, or /pair.",
      );
    }
    process.exit(1);
  }

  process.exit(0);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
