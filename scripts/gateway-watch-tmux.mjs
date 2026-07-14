#!/usr/bin/env node
// Starts gateway watch in tmux while preserving useful dev environment state.
import { spawnSync } from "node:child_process";
import process from "node:process";
import { pathToFileURL } from "node:url";

const TMUX_DISABLE_VALUES = new Set(["0", "false", "no", "off"]);
const TMUX_ATTACH_DISABLE_VALUES = new Set(["0", "false", "no", "off"]);
const TMUX_ATTACH_FORCE_VALUES = new Set(["1", "true", "yes", "on"]);
const DEFAULT_PROFILE_NAME = "main";
const DEFAULT_BENCHMARK_PROFILE_DIR = ".artifacts/gateway-watch-profiles";
const DEFAULT_BENCHMARK_PROFILE_MAX_FILES = "40";
const RUN_NODE_CPU_PROF_DIR_ENV = "OPENCLAW_RUN_NODE_CPU_PROF_DIR";
const RUN_NODE_CPU_PROF_MAX_FILES_ENV = "OPENCLAW_RUN_NODE_CPU_PROF_MAX_FILES";
const RUN_NODE_OUTPUT_LOG_ENV = "OPENCLAW_RUN_NODE_OUTPUT_LOG";
const RUN_NODE_FILTER_SYNC_IO_STDERR_ENV = "OPENCLAW_RUN_NODE_FILTER_SYNC_IO_STDERR";
const RAW_WATCH_SCRIPT = "scripts/watch-node.mjs";
const RUN_NODE_SCRIPT = "scripts/run-node.mjs";
const GATEWAY_WATCH_TMUX_SCRIPT = "scripts/gateway-watch-tmux.mjs";
const SERVICE_HANDOFF_ARG = "--handoff-managed-service";
const DEFAULT_GATEWAY_PORT = "18789";
const TMUX_CWD_ENV_KEY = "OPENCLAW_GATEWAY_WATCH_CWD";
const TMUX_CWD_OPTION_KEY = "@openclaw.gateway_watch.cwd";
const TMUX_CHILD_ENV_KEYS = [
  "NODE_OPTIONS",
  "OPENCLAW_CONFIG_PATH",
  "OPENCLAW_DIAGNOSTICS",
  "OPENCLAW_DIAGNOSTICS_EVENT_LOOP",
  "OPENCLAW_DIAGNOSTICS_TIMELINE_PATH",
  "OPENCLAW_GATEWAY_PORT",
  "OPENCLAW_GATEWAY_RESTART_TRACE",
  "OPENCLAW_GATEWAY_STARTUP_TRACE",
  "OPENCLAW_GATEWAY_WATCH_AUTO_DOCTOR",
  "OPENCLAW_HOME",
  "OPENCLAW_PROFILE",
  RUN_NODE_CPU_PROF_DIR_ENV,
  RUN_NODE_CPU_PROF_MAX_FILES_ENV,
  RUN_NODE_FILTER_SYNC_IO_STDERR_ENV,
  RUN_NODE_OUTPUT_LOG_ENV,
  "OPENCLAW_SKIP_CHANNELS",
  "OPENCLAW_STATE_DIR",
  "OPENCLAW_TRACE_SYNC_IO",
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

const hasArg = (args, flag) =>
  args.some((arg) => arg === flag || (typeof arg === "string" && arg.startsWith(`${flag}=`)));

const parsePortValue = (raw, { allowHost = false } = {}) => {
  const trimmed = String(raw ?? "").trim();
  let portText = /^\d+$/.test(trimmed) ? trimmed : null;
  if (!portText && allowHost) {
    const bracketed = trimmed.match(/^\[[^\]]+\]:(\d+)$/);
    if (bracketed?.[1]) {
      portText = bracketed[1];
    } else {
      const firstColon = trimmed.indexOf(":");
      const lastColon = trimmed.lastIndexOf(":");
      const suffix =
        firstColon > 0 && firstColon === lastColon ? trimmed.slice(firstColon + 1) : "";
      portText = /^\d+$/.test(suffix) ? suffix : null;
    }
  }
  const port = portText ? Number(portText) : Number.NaN;
  return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : null;
};

const resolveGatewayWatchPort = ({ args, env }) => {
  // Keep CLI precedence and Compose-style env parsing aligned with the Gateway
  // owners in src/cli/gateway-cli/run.ts and src/config/paths.ts.
  if (hasArg(args, "--port")) {
    return { explicitCli: true, port: parsePortValue(readArgValue(args, "--port")) };
  }
  return {
    explicitCli: false,
    port: parsePortValue(env.OPENCLAW_GATEWAY_PORT, { allowHost: true }),
  };
};

const resolveGatewayWatchProfile = ({ args, env }) => {
  if (hasArg(args, "--profile")) {
    return readArgValue(args, "--profile") ?? "";
  }
  const gatewayIndex = args.indexOf("gateway");
  const devIndex = args.indexOf("--dev");
  if (devIndex >= 0 && (gatewayIndex < 0 || devIndex < gatewayIndex)) {
    return "dev";
  }
  return env.OPENCLAW_PROFILE || null;
};

const joinArtifactPath = (dir, basename) => {
  const normalizedDir = String(dir || DEFAULT_BENCHMARK_PROFILE_DIR).replace(/[\\/]+$/g, "");
  return `${normalizedDir || "."}/${basename}`;
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
    nextEnv[RUN_NODE_CPU_PROF_MAX_FILES_ENV] ??= DEFAULT_BENCHMARK_PROFILE_MAX_FILES;
    nextEnv.OPENCLAW_TRACE_SYNC_IO ??= "0";
    if (nextEnv.OPENCLAW_TRACE_SYNC_IO === "1") {
      nextEnv[RUN_NODE_OUTPUT_LOG_ENV] ??= joinArtifactPath(
        nextEnv[RUN_NODE_CPU_PROF_DIR_ENV],
        "gateway-watch-output.log",
      );
      nextEnv[RUN_NODE_FILTER_SYNC_IO_STDERR_ENV] ??= "1";
    }
  }
  return {
    args: benchmarkNoForceSeen
      ? passthroughArgs.filter((arg) => arg !== "--force")
      : passthroughArgs,
    benchmarkNoForce: benchmarkNoForceSeen,
    benchmarkProfileDir: nextEnv[RUN_NODE_CPU_PROF_DIR_ENV] || null,
    benchmarkTraceOutputLog:
      nextEnv[RUN_NODE_FILTER_SYNC_IO_STDERR_ENV] === "1"
        ? nextEnv[RUN_NODE_OUTPUT_LOG_ENV] || null
        : null,
    env: nextEnv,
  };
};

/**
 * Resolves the tmux session name for gateway watch arguments/environment.
 */
export const resolveGatewayWatchTmuxSessionName = ({ args = [], env = process.env } = {}) => {
  const profile = resolveGatewayWatchProfile({ args, env });
  const { port } = resolveGatewayWatchPort({ args, env });
  const parts = [
    "openclaw",
    "gateway",
    "watch",
    sanitizeSessionPart(profile ?? DEFAULT_PROFILE_NAME),
  ];
  if (port && String(port) !== DEFAULT_GATEWAY_PORT) {
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

/**
 * Builds the shell command executed inside the tmux gateway watch session.
 */
export const buildGatewayWatchTmuxCommand = ({
  args = [],
  cwd = process.cwd(),
  env = process.env,
  nodePath = process.execPath,
  sessionName,
} = {}) => {
  const shell = resolveShell(env);
  const colorEnv = resolveColorEnv(env);
  // tmux sessions retain their own environment across respawns. Clear supported
  // selectors before applying the invoking process's current values.
  const childEnv = [
    "env",
    ...colorEnv.options,
    ...TMUX_CHILD_ENV_KEYS.flatMap((key) => ["-u", key]),
    `OPENCLAW_GATEWAY_WATCH_TMUX_CHILD=1`,
    `OPENCLAW_GATEWAY_WATCH_SESSION=${sessionName}`,
    ...colorEnv.assignments,
    ...TMUX_CHILD_ENV_KEYS.flatMap((key) =>
      env[key] == null || env[key] === "" ? [] : [`${key}=${env[key]}`],
    ),
  ];
  const childEnvCommand = childEnv.map(shellQuote);
  const handoffCommand = [
    ...childEnvCommand,
    shellQuote(nodePath),
    shellQuote(GATEWAY_WATCH_TMUX_SCRIPT),
    shellQuote(SERVICE_HANDOFF_ARG),
    ...args.map(shellQuote),
    "&&",
  ];
  const watchCommand = [
    "cd",
    shellQuote(cwd),
    "&&",
    ...handoffCommand,
    "exec",
    ...childEnvCommand,
    shellQuote(nodePath),
    shellQuote(RAW_WATCH_SCRIPT),
    ...args.map(shellQuote),
  ].join(" ");
  return `exec ${shellQuote(shell)} -lc ${shellQuote(watchCommand)}`;
};

const parseTrailingJsonObject = (raw) => {
  const text = String(raw ?? "").trim();
  for (let index = text.lastIndexOf("{"); index >= 0; index = text.lastIndexOf("{", index - 1)) {
    try {
      return JSON.parse(text.slice(index));
    } catch {
      // Build output can precede the CLI JSON; keep scanning for the outer object.
    }
  }
  return null;
};

/** Stops the matching managed service without targeting an unrelated listener. */
export const runGatewayWatchServiceHandoff = (params = {}) => {
  const args = params.args ?? [];
  const cwd = params.cwd ?? process.cwd();
  const env = params.env ? { ...params.env } : { ...process.env };
  const nodePath = params.nodePath ?? process.execPath;
  const spawnSyncImpl = params.spawnSync ?? spawnSync;
  const stderr = params.stderr ?? process.stderr;
  const profile = resolveGatewayWatchProfile({ args, env });
  const profileArgs = profile === null ? [] : ["--profile", profile];
  const statusResult = spawnSyncImpl(
    nodePath,
    [RUN_NODE_SCRIPT, ...profileArgs, "gateway", "status", "--json", "--no-probe"],
    {
      cwd,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (statusResult.error || statusResult.status !== 0) {
    const detail =
      statusResult.error?.message || String(statusResult.stderr || "").trim() || "unknown error";
    log(stderr, `failed to inspect the managed Gateway service before watch: ${detail}`);
    return statusResult.status || 1;
  }
  const status = parseTrailingJsonObject(statusResult.stdout);
  if (!status || typeof status !== "object") {
    log(stderr, "failed to parse managed Gateway service status before watch");
    return 1;
  }
  const managedServiceActive =
    status.service?.loaded === true || status.service?.runtime?.status === "running";
  if (!managedServiceActive) {
    return 0;
  }

  const { explicitCli, port: requestedPort } = resolveGatewayWatchPort({ args, env });
  if (explicitCli && requestedPort === null) {
    // The watcher will report the invalid CLI value without disrupting a healthy service.
    return 0;
  }
  const managedPort = parsePortValue(status.gateway?.port);
  const currentConfigPort = parsePortValue(status.portCli?.port ?? status.gateway?.port);
  const watchPort = requestedPort ?? currentConfigPort;
  if (managedPort === null || watchPort === null) {
    log(stderr, "failed to resolve the Gateway watch port before service handoff");
    return 1;
  }
  if (watchPort !== managedPort) {
    log(
      stderr,
      `gateway:watch leaving managed Gateway on port ${managedPort}; watching port ${watchPort}`,
    );
    return 0;
  }

  // If the service unloads after status, keep the unmanaged fallback scoped to
  // the watch target instead of a lower-precedence environment port.
  const stopEnv = { ...env };
  if (explicitCli) {
    stopEnv.OPENCLAW_GATEWAY_PORT = String(watchPort);
  }
  const stopResult = spawnSyncImpl(nodePath, [RUN_NODE_SCRIPT, ...profileArgs, "gateway", "stop"], {
    cwd,
    env: stopEnv,
    stdio: "inherit",
  });
  if (stopResult.error) {
    log(
      stderr,
      `failed to stop the managed Gateway service before watch: ${stopResult.error.message}`,
    );
    return 1;
  }
  return stopResult.status ?? (stopResult.signal ? 1 : 0);
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
  // TERM=dumb pseudo-TTYs cannot satisfy tmux's clear/cursor requirements.
  const term = String(env.TERM ?? "")
    .trim()
    .toLowerCase();
  return (
    !env.CI &&
    stdinIsTTY === true &&
    stdoutIsTTY === true &&
    (Boolean(env.TMUX) || (term !== "" && term !== "dumb"))
  );
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

const retainTmuxPaneOnExit = ({ sessionName, spawnSyncImpl }) =>
  runTmux(spawnSyncImpl, ["set-option", "-w", "-t", sessionName, "remain-on-exit", "on"]);

/**
 * Runs the gateway-watch tmux wrapper main flow.
 */
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
  if (resolvedArgs.benchmarkTraceOutputLog) {
    log(
      deps.stderr,
      `gateway:watch benchmark trace output: ${resolvedArgs.benchmarkTraceOutputLog}`,
    );
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

  const launchPane = () =>
    runTmux(deps.spawnSync, ["respawn-pane", "-k", "-t", sessionName, "-c", deps.cwd, command]);
  const prepareSession = () => retainTmuxPaneOnExit({ sessionName, spawnSyncImpl: deps.spawnSync });
  const startSession = () => {
    // Create a durable shell pane first so remain-on-exit is active before the
    // watcher can fail. Agents can then capture the original startup error.
    const created = runTmux(deps.spawnSync, [
      "new-session",
      "-d",
      "-s",
      sessionName,
      "-c",
      deps.cwd,
    ]);
    if (created.error || created.status !== 0) {
      return created;
    }
    const prepared = prepareSession();
    if (prepared.error || prepared.status !== 0) {
      runTmux(deps.spawnSync, ["kill-session", "-t", sessionName]);
      return prepared;
    }
    return launchPane();
  };
  const restartSession = () => {
    const prepared = prepareSession();
    if (prepared.error || prepared.status !== 0) {
      return prepared;
    }
    return launchPane();
  };
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
  deps.stdout.write(`Logs: tmux capture-pane -ep -t ${sessionName} -S -200\n`);
  deps.stdout.write(`Cwd: tmux show-options -v -t ${sessionName} ${TMUX_CWD_OPTION_KEY}\n`);
  deps.stdout.write("Restart: rerun the same pnpm gateway:watch command\n");
  deps.stdout.write(`Stop: tmux kill-session -t ${sessionName}\n`);
  return 0;
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const args = process.argv.slice(2);
  process.exit(
    args[0] === SERVICE_HANDOFF_ARG
      ? runGatewayWatchServiceHandoff({ args: args.slice(1) })
      : runGatewayWatchTmuxMain({ args }),
  );
}
