#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import process from "node:process";
import { pathToFileURL } from "node:url";

const TMUX_DISABLE_VALUES = new Set(["0", "false", "no", "off"]);
const TMUX_ATTACH_DISABLE_VALUES = new Set(["0", "false", "no", "off"]);
const TMUX_ATTACH_FORCE_VALUES = new Set(["1", "true", "yes", "on"]);
const DEFAULT_PROFILE_NAME = "main";
const DEFAULT_BENCHMARK_PROFILE_DIR = ".artifacts/gateway-watch-profiles";
const RUN_NODE_CPU_PROF_DIR_ENV = "OPENCLAW_RUN_NODE_CPU_PROF_DIR";
const RAW_WATCH_SCRIPT = "scripts/watch-node.mjs";
const TMUX_CWD_ENV_KEY = "OPENCLAW_GATEWAY_WATCH_CWD";
const TMUX_CWD_OPTION_KEY = "@openclaw.gateway_watch.cwd";
const TMUX_CHILD_ENV_KEYS = [
  "NODE_OPTIONS",
  "OPENCLAW_CONFIG_PATH",
  "OPENCLAW_GATEWAY_PORT",
  "OPENCLAW_HOME",
  "OPENCLAW_PROFILE",
  RUN_NODE_CPU_PROF_DIR_ENV,
  "OPENCLAW_SKIP_CHANNELS",
  "OPENCLAW_STATE_DIR",
];

const sanitizeSessionPart = (value) => {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || DEFAULT_PROFILE_NAME;
};

const shellQuote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;

const readArgValue = (args, flag) => {
  const prefix = `${flag}=`;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === flag) {
      const next = args[index + 1];
      return typeof next === "string" && !next.startsWith("-") ? next : null;
    }
    if (typeof arg === "string" && arg.startsWith(prefix)) {
      return arg.slice(prefix.length);
    }
  }
  return null;
};

const resolveGatewayWatchBenchmarkArgs = ({ args = [], env = process.env } = {}) => {
  const passthroughArgs = [];
  let benchmarkDir = null;
  let benchmarkFlagSeen = false;
  let benchmarkNoForceSeen = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--benchmark") {
      benchmarkFlagSeen = true;
      benchmarkDir ??= DEFAULT_BENCHMARK_PROFILE_DIR;
      continue;
    }
    if (arg === "--benchmark-no-force") {
      benchmarkFlagSeen = true;
      benchmarkNoForceSeen = true;
      benchmarkDir ??= DEFAULT_BENCHMARK_PROFILE_DIR;
      continue;
    }
    if (typeof arg === "string" && arg.startsWith("--benchmark=")) {
      benchmarkFlagSeen = true;
      benchmarkDir = arg.slice("--benchmark=".length) || DEFAULT_BENCHMARK_PROFILE_DIR;
      continue;
    }
    if (arg === "--benchmark-dir") {
      benchmarkFlagSeen = true;
      const next = args[index + 1];
      if (typeof next === "string" && !next.startsWith("-")) {
        benchmarkDir = next;
        index += 1;
      } else {
        benchmarkDir ??= DEFAULT_BENCHMARK_PROFILE_DIR;
      }
      continue;
    }
    if (typeof arg === "string" && arg.startsWith("--benchmark-dir=")) {
      benchmarkFlagSeen = true;
      benchmarkDir = arg.slice("--benchmark-dir=".length) || DEFAULT_BENCHMARK_PROFILE_DIR;
      continue;
    }
    passthroughArgs.push(arg);
  }

  const nextEnv = { ...env };
  if (benchmarkFlagSeen) {
    nextEnv[RUN_NODE_CPU_PROF_DIR_ENV] =
      benchmarkDir || nextEnv[RUN_NODE_CPU_PROF_DIR_ENV] || DEFAULT_BENCHMARK_PROFILE_DIR;
  }
  return {
    args: benchmarkNoForceSeen
      ? passthroughArgs.filter((arg) => arg !== "--force")
      : passthroughArgs,
    benchmarkNoForce: benchmarkNoForceSeen,
    benchmarkProfileDir: nextEnv[RUN_NODE_CPU_PROF_DIR_ENV] || null,
    env: nextEnv,
  };
};

export const resolveGatewayWatchTmuxSessionName = ({ args = [], env = process.env } = {}) => {
  const profile =
    env.OPENCLAW_PROFILE ||
    readArgValue(args, "--profile") ||
    (args.includes("--dev") ? "dev" : null);
  const port = env.OPENCLAW_GATEWAY_PORT || readArgValue(args, "--port");
  const parts = [
    "openclaw",
    "gateway",
    "watch",
    sanitizeSessionPart(profile ?? DEFAULT_PROFILE_NAME),
  ];
  if (port && port !== "18789") {
    parts.push(sanitizeSessionPart(port));
  }
  return parts.join("-");
};

const resolveShell = (env) => env.SHELL || "/bin/sh";

const resolveColorEnv = (env) => {
  const forceColor = env.FORCE_COLOR;
  if (forceColor == null || forceColor === "") {
    return { assignments: ["FORCE_COLOR=1"], options: ["-u", "NO_COLOR"] };
  }
  if (String(forceColor).trim() !== "0") {
    return { assignments: [`FORCE_COLOR=${forceColor}`], options: ["-u", "NO_COLOR"] };
  }
  return { assignments: [`FORCE_COLOR=${forceColor}`], options: [] };
};

export const buildGatewayWatchTmuxCommand = ({
  args = [],
  cwd = process.cwd(),
  env = process.env,
  nodePath = process.execPath,
  sessionName,
} = {}) => {
  const shell = resolveShell(env);
  const colorEnv = resolveColorEnv(env);
  const childEnv = [
    "env",
    ...colorEnv.options,
    `OPENCLAW_GATEWAY_WATCH_TMUX_CHILD=1`,
    `OPENCLAW_GATEWAY_WATCH_SESSION=${sessionName}`,
    ...colorEnv.assignments,
    ...TMUX_CHILD_ENV_KEYS.flatMap((key) =>
      env[key] == null || env[key] === "" ? [] : [`${key}=${env[key]}`],
    ),
  ];
  const watchCommand = [
    "cd",
    shellQuote(cwd),
    "&&",
    "exec",
    ...childEnv.map(shellQuote),
    shellQuote(nodePath),
    shellQuote(RAW_WATCH_SCRIPT),
    ...args.map(shellQuote),
  ].join(" ");
  return `exec ${shellQuote(shell)} -lc ${shellQuote(watchCommand)}`;
};

const runForegroundWatcher = ({ args, cwd, env, nodePath, spawnSyncImpl, stdio = "inherit" }) => {
  const result = spawnSyncImpl(nodePath, [RAW_WATCH_SCRIPT, ...args], {
    cwd,
    env,
    stdio,
  });
  return result.status ?? (result.signal ? 1 : 0);
};

const runTmux = (spawnSyncImpl, args, options = {}) =>
  spawnSyncImpl("tmux", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });

const log = (stderr, message) => {
  stderr.write(`[openclaw] ${message}\n`);
};

const getTmuxErrorText = (result) =>
  result.error?.message || String(result.stderr || "").trim() || "unknown error";

const isMissingTmuxTarget = (result) =>
  /can't find (?:session|window|pane)|no current target/i.test(getTmuxErrorText(result));

const shouldAttachTmux = ({ env, stdinIsTTY, stdoutIsTTY }) => {
  const raw = String(env.OPENCLAW_GATEWAY_WATCH_ATTACH ?? "").toLowerCase();
  if (TMUX_ATTACH_FORCE_VALUES.has(raw)) {
    return true;
  }
  if (TMUX_ATTACH_DISABLE_VALUES.has(raw)) {
    return false;
  }
  return !env.CI && stdinIsTTY === true && stdoutIsTTY === true;
};

const attachTmux = ({ env, sessionName, spawnSyncImpl }) => {
  const args = env.TMUX
    ? ["switch-client", "-t", sessionName]
    : ["attach-session", "-t", sessionName];
  return runTmux(spawnSyncImpl, args, { stdio: "inherit" });
};

const setTmuxSessionMetadata = ({ cwd, sessionName, spawnSyncImpl, stderr }) => {
  const updates = [
    ["set-option", "-q", "-t", sessionName, TMUX_CWD_OPTION_KEY, cwd],
    ["set-environment", "-t", sessionName, TMUX_CWD_ENV_KEY, cwd],
  ];
  for (const args of updates) {
    const result = runTmux(spawnSyncImpl, args);
    if (result.error || result.status !== 0) {
      log(stderr, `warning: failed to update tmux session metadata: ${getTmuxErrorText(result)}`);
      return;
    }
  }
};

export const runGatewayWatchTmuxMain = (params = {}) => {
  const resolvedArgs = resolveGatewayWatchBenchmarkArgs({
    args: params.args ?? process.argv.slice(2),
    env: params.env ? { ...params.env } : { ...process.env },
  });
  const deps = {
    args: resolvedArgs.args,
    cwd: params.cwd ?? process.cwd(),
    env: resolvedArgs.env,
    nodePath: params.nodePath ?? process.execPath,
    spawnSync: params.spawnSync ?? spawnSync,
    stderr: params.stderr ?? process.stderr,
    stdinIsTTY: params.stdinIsTTY ?? process.stdin.isTTY,
    stdout: params.stdout ?? process.stdout,
    stdoutIsTTY: params.stdoutIsTTY ?? process.stdout.isTTY,
  };

  if (resolvedArgs.benchmarkProfileDir) {
    log(deps.stderr, `gateway:watch benchmark CPU profiles: ${resolvedArgs.benchmarkProfileDir}`);
  }
  if (resolvedArgs.benchmarkNoForce) {
    log(deps.stderr, "gateway:watch benchmark running without --force");
  }

  if (TMUX_DISABLE_VALUES.has((deps.env.OPENCLAW_GATEWAY_WATCH_TMUX ?? "").toLowerCase())) {
    return runForegroundWatcher({
      args: deps.args,
      cwd: deps.cwd,
      env: deps.env,
      nodePath: deps.nodePath,
      spawnSyncImpl: deps.spawnSync,
    });
  }

  if (deps.env.OPENCLAW_GATEWAY_WATCH_TMUX_CHILD === "1") {
    return runForegroundWatcher({
      args: deps.args,
      cwd: deps.cwd,
      env: deps.env,
      nodePath: deps.nodePath,
      spawnSyncImpl: deps.spawnSync,
    });
  }

  const sessionName =
    params.sessionName ?? resolveGatewayWatchTmuxSessionName({ args: deps.args, env: deps.env });
  const command = buildGatewayWatchTmuxCommand({
    args: deps.args,
    cwd: deps.cwd,
    env: deps.env,
    nodePath: deps.nodePath,
    sessionName,
  });

  const hasSession = runTmux(deps.spawnSync, ["has-session", "-t", sessionName]);
  if (hasSession.error?.code === "ENOENT") {
    log(
      deps.stderr,
      "tmux is not installed or not on PATH; run `pnpm gateway:watch:raw` for foreground watch mode.",
    );
    return 1;
  }
  if (hasSession.error) {
    log(deps.stderr, `failed to query tmux session ${sessionName}: ${hasSession.error.message}`);
    return 1;
  }

  const startSession = () =>
    runTmux(deps.spawnSync, ["new-session", "-d", "-s", sessionName, "-c", deps.cwd, command]);
  const restartSession = () =>
    runTmux(deps.spawnSync, ["respawn-pane", "-k", "-t", sessionName, "-c", deps.cwd, command]);
  const action = hasSession.status === 0 ? "restarted" : "started";
  let result = hasSession.status === 0 ? restartSession() : startSession();
  if (hasSession.status === 0 && isMissingTmuxTarget(result)) {
    runTmux(deps.spawnSync, ["kill-session", "-t", sessionName]);
    result = startSession();
  }
  if (result.error?.code === "ENOENT") {
    log(
      deps.stderr,
      "tmux is not installed or not on PATH; run `pnpm gateway:watch:raw` for foreground watch mode.",
    );
    return 1;
  }
  if (result.error || result.status !== 0) {
    const detail = getTmuxErrorText(result);
    log(
      deps.stderr,
      `failed to ${action === "started" ? "start" : "restart"} tmux session ${sessionName}: ${detail}`,
    );
    return result.status || 1;
  }

  setTmuxSessionMetadata({
    cwd: deps.cwd,
    sessionName,
    spawnSyncImpl: deps.spawnSync,
    stderr: deps.stderr,
  });

  log(deps.stderr, `gateway:watch ${action} in tmux session ${sessionName}`);
  if (
    shouldAttachTmux({
      env: deps.env,
      stdinIsTTY: deps.stdinIsTTY,
      stdoutIsTTY: deps.stdoutIsTTY,
    })
  ) {
    const attachResult = attachTmux({
      env: deps.env,
      sessionName,
      spawnSyncImpl: deps.spawnSync,
    });
    if (attachResult.error || attachResult.status !== 0) {
      const detail =
        attachResult.error?.message || String(attachResult.stderr || "").trim() || "unknown error";
      log(deps.stderr, `failed to attach tmux session ${sessionName}: ${detail}`);
      return attachResult.status || 1;
    }
    return 0;
  }
  deps.stdout.write(`Attach: tmux attach -t ${sessionName}\n`);
  deps.stdout.write(`Cwd: tmux show-options -v -t ${sessionName} ${TMUX_CWD_OPTION_KEY}\n`);
  deps.stdout.write("Restart: rerun the same pnpm gateway:watch command\n");
  deps.stdout.write(`Stop: tmux kill-session -t ${sessionName}\n`);
  return 0;
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exit(runGatewayWatchTmuxMain());
}
