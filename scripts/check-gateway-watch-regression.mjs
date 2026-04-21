#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { writeBuildStamp } from "./build-stamp.mjs";
import { resolveBuildRequirement } from "./run-node.mjs";

const DEFAULTS = {
  outputDir: path.join(process.cwd(), ".local", "gateway-watch-regression"),
  windowMs: 10_000,
  readyTimeoutMs: 20_000,
  readySettleMs: 500,
  sigkillGraceMs: 10_000,
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
  OPENCLAW_TEST_MINIMAL_GATEWAY: "1",
  NODE_ENV: "test",
};

function parseArgs(argv) {
  const options = { ...DEFAULTS };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
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
        options.windowMs = Number(readValue());
        break;
      case "--ready-timeout-ms":
        options.readyTimeoutMs = Number(readValue());
        break;
      case "--ready-settle-ms":
        options.readySettleMs = Number(readValue());
        break;
      case "--sigkill-grace-ms":
        options.sigkillGraceMs = Number(readValue());
        break;
      case "--cpu-warn-ms":
        options.cpuWarnMs = Number(readValue());
        break;
      case "--cpu-fail-ms":
        options.cpuFailMs = Number(readValue());
        break;
      case "--dist-runtime-file-growth-max":
        options.distRuntimeFileGrowthMax = Number(readValue());
        break;
      case "--dist-runtime-byte-growth-max":
        options.distRuntimeByteGrowthMax = Number(readValue());
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

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function removePathIfExists(targetPath) {
  fs.rmSync(targetPath, { recursive: true, force: true });
}

function normalizePath(filePath) {
  return filePath.replaceAll("\\", "/");
}

function listTreeEntries(rootName) {
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
    const dirents = fs.readdirSync(current, { withFileTypes: true });
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

function humanBytes(bytes) {
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

function snapshotTree(rootName) {
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
    const currentStats = fs.lstatSync(current);
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

export function isIgnoredDistRuntimeWatchPath(entry) {
  return (
    entry === "dist-runtime/extensions/node_modules" ||
    entry.startsWith("dist-runtime/extensions/node_modules/")
  );
}

function summarizeDistRuntimeAddedPaths(added) {
  const addedPaths = added.filter((entry) => entry.startsWith("dist-runtime/"));
  const ignoredDependencyAddedPaths = addedPaths.filter(isIgnoredDistRuntimeWatchPath);
  const topologyAddedPaths = addedPaths.filter((entry) => !isIgnoredDistRuntimeWatchPath(entry));
  return {
    ignoredDependencyAddedPaths,
    topologyAddedPaths,
  };
}

function writeSnapshot(snapshotDir) {
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

function runCheckedCommand(command, args) {
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parsePsCpuTimeMs(timeText) {
  const [maybeDays, clockText] = timeText.includes("-") ? timeText.split("-", 2) : ["0", timeText];
  const days = Number(maybeDays);
  const parts = clockText.split(":");
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

function readProcessTreeCpuMs(rootPid) {
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

  const rows = [];
  for (const line of result.stdout.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)$/);
    if (!match) {
      continue;
    }
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    const cpuMs = parsePsCpuTimeMs(match[3]);
    if (!Number.isInteger(pid) || !Number.isInteger(ppid) || cpuMs == null) {
      continue;
    }
    rows.push({ pid, ppid, cpuMs });
  }

  const childrenByParent = new Map();
  const cpuByPid = new Map();
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
  const seen = new Set();
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

async function waitForGatewayReady(readText, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (/\[gateway\] ready \(/.test(readText())) {
      return true;
    }
    await sleep(100);
  }
  return false;
}

async function allocateLoopbackPort() {
  return await new Promise((resolve, reject) => {
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
          reject(closeErr);
          return;
        }
        resolve(port);
      });
    });
  });
}

function buildTimedWatchCommand(pidFilePath, timeFilePath, isolatedHomeDir, port) {
  const shellSource = [
    'echo "$$" > "$OPENCLAW_WATCH_PID_FILE"',
    'mkdir -p "$OPENCLAW_HOME/.openclaw"',
    `printf '%s\n' '{"gateway":{"controlUi":{"enabled":false}},"plugins":{"enabled":false}}' > "$OPENCLAW_HOME/.openclaw/openclaw.json"`,
    `exec node scripts/watch-node.mjs gateway --force --allow-unconfigured --port ${String(port)} --token watch-regression-token`,
  ].join("\n");
  const env = {
    OPENCLAW_WATCH_PID_FILE: pidFilePath,
    HOME: isolatedHomeDir,
    OPENCLAW_HOME: isolatedHomeDir,
    ...WATCH_GATEWAY_SKIP_ENV,
  };

  if (process.platform === "darwin") {
    return {
      command: "/usr/bin/time",
      args: ["-lp", "-o", timeFilePath, "/bin/sh", "-lc", shellSource],
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
      "/bin/sh",
      "-lc",
      shellSource,
    ],
    env,
  };
}

function parseTimingFile(timeFilePath) {
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

async function runTimedWatch(options, outputDir) {
  const pidFilePath = path.join(outputDir, "watch.pid");
  const timeFilePath = path.join(outputDir, "watch.time.log");
  const isolatedHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-gateway-watch-"));
  fs.writeFileSync(path.join(outputDir, "watch.home.txt"), `${isolatedHomeDir}\n`, "utf8");
  const stdoutPath = path.join(outputDir, "watch.stdout.log");
  const stderrPath = path.join(outputDir, "watch.stderr.log");
  for (const stalePath of [pidFilePath, timeFilePath, stdoutPath, stderrPath]) {
    removePathIfExists(stalePath);
  }
  const port = await allocateLoopbackPort();
  fs.writeFileSync(path.join(outputDir, "watch.port.txt"), `${String(port)}\n`, "utf8");
  const { command, args, env } = buildTimedWatchCommand(
    pidFilePath,
    timeFilePath,
    isolatedHomeDir,
    port,
  );
  const child = spawn(command, args, {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk) => {
    stdout += String(chunk);
  });
  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });

  const exitPromise = new Promise((resolve) => {
    child.on("exit", (code, signal) => resolve({ code, signal }));
  });

  let watchPid = null;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (fs.existsSync(pidFilePath)) {
      watchPid = Number(fs.readFileSync(pidFilePath, "utf8").trim());
      break;
    }
    await sleep(100);
  }

  const readyBeforeWindow = await waitForGatewayReady(
    () => `${stdout}\n${stderr}`,
    options.readyTimeoutMs,
  );
  if (readyBeforeWindow && options.readySettleMs > 0) {
    await sleep(options.readySettleMs);
  }
  const idleCpuStartMs = watchPid ? readProcessTreeCpuMs(watchPid) : null;
  await sleep(options.windowMs);
  const idleCpuEndMs = watchPid ? readProcessTreeCpuMs(watchPid) : null;

  if (watchPid) {
    try {
      process.kill(watchPid, "SIGTERM");
    } catch {
      // ignore
    }
  }

  const gracefulExit = await Promise.race([
    exitPromise,
    sleep(options.sigkillGraceMs).then(() => null),
  ]);

  if (gracefulExit === null) {
    if (watchPid) {
      try {
        process.kill(watchPid, "SIGKILL");
      } catch {
        // ignore
      }
    }
  }

  const exit = (await exitPromise) ?? { code: null, signal: null };
  fs.writeFileSync(stdoutPath, stdout, "utf8");
  fs.writeFileSync(stderrPath, stderr, "utf8");
  const timing = fs.existsSync(timeFilePath)
    ? parseTimingFile(timeFilePath)
    : { userSeconds: Number.NaN, sysSeconds: Number.NaN, elapsedSeconds: Number.NaN };

  return {
    exit,
    timing,
    readyBeforeWindow,
    idleCpuMs:
      idleCpuStartMs == null || idleCpuEndMs == null
        ? null
        : Math.max(0, idleCpuEndMs - idleCpuStartMs),
    stdoutPath,
    stderrPath,
    timeFilePath,
  };
}

function parsePathFile(filePath) {
  return fs
    .readFileSync(filePath, "utf8")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean);
}

function writeDiffArtifacts(outputDir, preDir, postDir) {
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

function fail(message) {
  console.error(`FAIL: ${message}`);
}

function warn(message) {
  console.error(`WARN: ${message}`);
}

function detectWatchBuildReason(stdout, stderr) {
  const combined = `${stdout}\n${stderr}`;
  const match = combined.match(/Building TypeScript \(dist is stale: ([a-z_]+)/);
  return match?.[1] ?? null;
}

function buildRunNodeDeps(env) {
  const cwd = process.cwd();
  return {
    cwd,
    env,
    fs,
    spawnSync,
    distRoot: path.join(cwd, "dist"),
    distEntry: path.join(cwd, "dist", "/entry.js"),
    buildStampPath: path.join(cwd, "dist", ".buildstamp"),
    sourceRoots: ["src", "extensions"].map((sourceRoot) => ({
      name: sourceRoot,
      path: path.join(cwd, sourceRoot),
    })),
    configFiles: ["tsconfig.json", "package.json", "tsdown.config.ts"].map((filePath) =>
      path.join(cwd, filePath),
    ),
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  ensureDir(options.outputDir);
  if (!options.skipBuild) {
    runCheckedCommand("pnpm", ["build"]);
    // The watch harness must start from a completed-build baseline. Refresh
    // the build stamp after the full build pipeline finishes so run-node does
    // not spuriously rebuild inside the bounded watch window.
    writeBuildStamp({ cwd: process.cwd() });
  }

  const preflightBuildRequirement = resolveBuildRequirement(buildRunNodeDeps(process.env));
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

  const distRuntimeAddedPathSummary = summarizeDistRuntimeAddedPaths(diff.added);
  const distRuntimeAddedPaths = distRuntimeAddedPathSummary.topologyAddedPaths.length;
  const distRuntimeIgnoredDependencyAddedPaths =
    distRuntimeAddedPathSummary.ignoredDependencyAddedPaths.length;
  const distRuntimeFileGrowth = distRuntimeAddedPaths;
  const distRuntimeByteGrowth =
    distRuntimeAddedPaths === 0
      ? 0
      : post.distRuntime.apparentBytes - pre.distRuntime.apparentBytes;
  const totalCpuMs = Math.round(
    (watchResult.timing.userSeconds + watchResult.timing.sysSeconds) * 1000,
  );
  const cpuMs = watchResult.idleCpuMs ?? totalCpuMs;
  const watchTriggeredBuild =
    fs
      .readFileSync(watchResult.stderrPath, "utf8")
      .includes("Building TypeScript (dist is stale") ||
    fs.readFileSync(watchResult.stdoutPath, "utf8").includes("Building TypeScript (dist is stale");
  const watchBuildReason = detectWatchBuildReason(
    fs.readFileSync(watchResult.stdoutPath, "utf8"),
    fs.readFileSync(watchResult.stderrPath, "utf8"),
  );

  const summary = {
    windowMs: options.windowMs,
    watchTriggeredBuild,
    watchBuildReason,
    cpuMs,
    totalCpuMs,
    readyBeforeWindow: watchResult.readyBeforeWindow,
    cpuWarnMs: options.cpuWarnMs,
    cpuFailMs: options.cpuFailMs,
    distRuntimeFileGrowth,
    distRuntimeFileGrowthMax: options.distRuntimeFileGrowthMax,
    distRuntimeByteGrowth,
    distRuntimeByteGrowthMax: options.distRuntimeByteGrowthMax,
    distRuntimeAddedPaths,
    distRuntimeIgnoredDependencyAddedPaths,
    addedPaths: diff.added.length,
    removedPaths: diff.removed.length,
    watchExit: watchResult.exit,
    timing: watchResult.timing,
  };
  fs.writeFileSync(
    path.join(options.outputDir, "summary.json"),
    `${JSON.stringify(summary, null, 2)}\n`,
  );

  console.log(JSON.stringify(summary, null, 2));

  const failures = [];
  const warnings = [];
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

  for (const message of warnings) {
    warn(message);
  }

  if (failures.length > 0) {
    for (const message of failures) {
      fail(message);
    }
    if (!failures.every((message) => message.includes("dirty watched source tree"))) {
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
