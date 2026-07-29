#!/usr/bin/env node
// Runs additional architecture and boundary checks with sharding, concurrency,
// timeout handling, and grouped CI output.
import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import pMap from "p-map";
import prettyMilliseconds from "pretty-ms";

const DEFAULT_CHECK_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_OUTPUT_MAX_BYTES = 512 * 1024;
// Boundary checks are disposable subprocesses; bound descendant cleanup after timeout.
const TIMEOUT_KILL_GRACE_MS = 250;
const PROCESS_GROUP_EXIT_POLL_MS = 25;
const POST_FORCE_KILL_WAIT_MS = 250;
const MAX_TIMER_TIMEOUT_MS = 2_147_000_000;

/** Ordered list of supplemental boundary checks used by CI sharding. */
// prompt:snapshots:check is intentionally absent: it regenerates snapshots by
// running real embedded-agent turns (~2min) and owns a dedicated CI lane
// (check-prompt-snapshots) so no boundary shard carries that wall clock.
export const BOUNDARY_CHECKS = [
  ["plugin-extension-boundary", "pnpm", ["run", "lint:plugins:no-extension-imports"]],
  ["lint:docker-e2e", "pnpm", ["run", "lint:docker-e2e"]],
  ["lint:tmp:no-random-messaging", "pnpm", ["run", "lint:tmp:no-random-messaging"]],
  ["lint:tmp:channel-agnostic-boundaries", "pnpm", ["run", "lint:tmp:channel-agnostic-boundaries"]],
  ["lint:tmp:tsgo-core-boundary", "pnpm", ["run", "lint:tmp:tsgo-core-boundary"]],
  ["lint:tmp:no-raw-channel-fetch", "pnpm", ["run", "lint:tmp:no-raw-channel-fetch"]],
  ["lint:tmp:no-raw-http2-imports", "pnpm", ["run", "lint:tmp:no-raw-http2-imports"]],
  ["lint:agent:ingress-owner", "pnpm", ["run", "lint:agent:ingress-owner"]],
  [
    "lint:plugins:no-register-http-handler",
    "pnpm",
    ["run", "lint:plugins:no-register-http-handler"],
  ],
  [
    "lint:plugins:no-monolithic-plugin-sdk-entry-imports",
    "pnpm",
    ["run", "lint:plugins:no-monolithic-plugin-sdk-entry-imports"],
  ],
  [
    "lint:plugins:no-extension-src-imports",
    "pnpm",
    ["run", "lint:plugins:no-extension-src-imports"],
  ],
  [
    "lint:plugins:no-extension-test-core-imports",
    "pnpm",
    ["run", "lint:plugins:no-extension-test-core-imports"],
  ],
  [
    "lint:plugins:plugin-sdk-subpaths-exported",
    "pnpm",
    ["run", "lint:plugins:plugin-sdk-subpaths-exported"],
  ],
  ["deps:root-ownership:check", "pnpm", ["deps:root-ownership:check"]],
  ["web-search-provider-boundary", "pnpm", ["run", "lint:web-search-provider-boundaries"]],
  ["web-fetch-provider-boundary", "pnpm", ["run", "lint:web-fetch-provider-boundaries"]],
  [
    "extension-src-outside-plugin-sdk-boundary",
    "pnpm",
    ["run", "lint:extensions:no-src-outside-plugin-sdk"],
  ],
  [
    "extension-plugin-sdk-internal-boundary",
    "pnpm",
    ["run", "lint:extensions:no-plugin-sdk-internal"],
  ],
  [
    "extension-relative-outside-package-boundary",
    "pnpm",
    ["run", "lint:extensions:no-relative-outside-package"],
  ],
  [
    "lint:extensions:telegram-grammy-types",
    "pnpm",
    ["run", "lint:extensions:telegram-grammy-types"],
  ],
  ["lint:ui:no-raw-window-open", "pnpm", ["lint:ui:no-raw-window-open"]],
  ["native-state-schema-version", "node", ["scripts/check-native-state-schema-version.mjs"]],
].map(([label, command, args]) => ({ label, command, args }));

/**
 * Resolves the configured boundary-check concurrency.
 */
export function resolveConcurrency(value, fallback = 4, label = "concurrency") {
  return resolvePositiveInteger(value, fallback, label);
}

/**
 * Parses positive integer CLI/env options with a fallback.
 */
export function resolvePositiveInteger(value, fallback, label = "value") {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  const text = String(value).trim();
  if (!/^\d+$/u.test(text)) {
    throw new Error(`${label} must be a positive integer; got: ${value}`);
  }
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${label} must be a positive integer; got: ${value}`);
  }
  return parsed;
}

function resolveTimerTimeoutMs(valueMs) {
  const value = Number(valueMs);
  if (!Number.isFinite(value)) {
    return MAX_TIMER_TIMEOUT_MS;
  }
  return Math.min(Math.max(Math.floor(value), 1), MAX_TIMER_TIMEOUT_MS);
}

/**
 * Parses one N/TOTAL shard selector into zero-based index form.
 */
export function parseShardSpec(value) {
  if (!value) {
    return null;
  }
  const match = String(value).match(/^(\d+)\/(\d+)$/u);
  if (!match) {
    throw new Error(`Invalid shard spec '${value}' (expected N/TOTAL)`);
  }
  const index = Number(match[1]);
  const count = Number(match[2]);
  if (
    !Number.isSafeInteger(index) ||
    !Number.isSafeInteger(count) ||
    index < 1 ||
    count < 1 ||
    index > count
  ) {
    throw new Error(`Invalid shard spec '${value}' (expected 1 <= N <= TOTAL)`);
  }
  return { count, index: index - 1, label: `${index}/${count}` };
}

/**
 * Parses a comma-separated list of N/TOTAL shard selectors.
 */
export function parseShardSelection(value) {
  if (!value) {
    return null;
  }
  return String(value)
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const shard = parseShardSpec(part);
      if (!shard) {
        throw new Error(`Invalid shard spec '${value}'`);
      }
      return shard;
    });
}

/**
 * Selects checks whose ordinal belongs to the requested shard set.
 */
export function selectChecksForShard(checks, shardSpec) {
  const shards =
    typeof shardSpec === "string"
      ? parseShardSelection(shardSpec)
      : Array.isArray(shardSpec)
        ? shardSpec
        : shardSpec
          ? [shardSpec]
          : null;
  if (!shards || shards.length === 0) {
    return checks;
  }
  return checks.filter((_check, index) =>
    shards.some((shard) => index % shard.count === shard.index),
  );
}

/**
 * Formats a check command for CI group output.
 */
export function formatCommand({ command, args }) {
  return [command, ...args].join(" ");
}

function decodeUtf8Tail(buffer) {
  let start = 0;
  while (start < buffer.length && (buffer[start] & 0b1100_0000) === 0b1000_0000) {
    start += 1;
  }
  // Appends are complete JS strings; only a byte slice's leading boundary can be partial.
  return buffer.subarray(start).toString("utf8");
}

/**
 * Keeps only the tail of noisy check output so failure logs stay bounded.
 */
export function createBoundedOutputBuffer(maxBytes = DEFAULT_OUTPUT_MAX_BYTES) {
  const limit = Math.max(1, maxBytes);
  const chunks = [];
  let bytes = 0;
  let truncated = false;

  const append = (value) => {
    const text = String(value);
    const textBytes = Buffer.byteLength(text);
    if (textBytes >= limit) {
      const buffer = Buffer.from(text);
      const tail = decodeUtf8Tail(buffer.subarray(buffer.length - limit));
      chunks.splice(0, chunks.length, tail);
      bytes = Buffer.byteLength(tail);
      truncated = true;
      return;
    }

    chunks.push(text);
    bytes += textBytes;
    while (bytes > limit && chunks.length > 0) {
      const first = chunks[0];
      const firstBytes = Buffer.byteLength(first);
      const overflow = bytes - limit;
      if (firstBytes <= overflow) {
        chunks.shift();
        bytes -= firstBytes;
        truncated = true;
        continue;
      }

      const buffer = Buffer.from(first);
      const tail = decodeUtf8Tail(buffer.subarray(overflow));
      chunks[0] = tail;
      bytes = chunks.reduce((total, chunk) => total + Buffer.byteLength(chunk), 0);
      truncated = true;
    }
  };

  return {
    append,
    read() {
      const output = chunks.join("");
      return truncated ? `[output truncated to last ${limit} bytes]\n${output}` : output;
    },
  };
}

function terminateChild(child, signal) {
  if (process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {}
  }
  child.kill(signal);
}

function processGroupAlive(child) {
  if (process.platform === "win32" || !child.pid) {
    return false;
  }
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function waitForProcessGroupExit(child, timeoutMs) {
  const deadlineAt = Date.now() + timeoutMs;
  while (Date.now() < deadlineAt) {
    if (!processGroupAlive(child)) {
      return true;
    }
    await new Promise((resolvePoll) => {
      setTimeout(resolvePoll, PROCESS_GROUP_EXIT_POLL_MS);
    });
  }
  return !processGroupAlive(child);
}

async function finishTerminatedProcessTree(child, timeoutKillGraceMs = TIMEOUT_KILL_GRACE_MS) {
  if (processGroupAlive(child)) {
    await waitForProcessGroupExit(child, timeoutKillGraceMs);
  }
  if (processGroupAlive(child)) {
    terminateChild(child, "SIGKILL");
    await waitForProcessGroupExit(child, POST_FORCE_KILL_WAIT_MS);
  }
}

function terminateActiveChildren(activeChildren, signal) {
  for (const child of activeChildren) {
    terminateChild(child, signal);
  }
}

function installActiveChildCleanup(activeChildren) {
  let active = true;
  let shutdownChildren = [];
  let shutdownPromise = null;
  let shutdownForceKillTimer = null;
  let resolveShutdownForceKill = null;
  const removeHandlers = () => {
    for (const [signal, handler] of signalHandlers) {
      process.off(signal, handler);
    }
    process.off("exit", exitHandler);
  };
  const forceKillShutdownChildren = () => {
    if (shutdownForceKillTimer) {
      clearTimeout(shutdownForceKillTimer);
      shutdownForceKillTimer = null;
    }
    terminateActiveChildren(shutdownChildren, "SIGKILL");
    resolveShutdownForceKill?.();
  };
  const cleanup = (signal, { waitForExit = false } = {}) => {
    if (!active) {
      return shutdownPromise ?? Promise.resolve();
    }
    active = false;
    shutdownChildren = [...activeChildren];
    terminateActiveChildren(shutdownChildren, signal);
    if (!waitForExit) {
      return Promise.resolve();
    }
    shutdownPromise = new Promise((resolveForceKill) => {
      resolveShutdownForceKill = resolveForceKill;
      // Keep this timer ref'ed: once the leader exits, group liveness can look
      // gone while descendants are still running and still need the force kill.
      shutdownForceKillTimer = setTimeout(forceKillShutdownChildren, TIMEOUT_KILL_GRACE_MS);
    })
      .then(() =>
        Promise.all(
          shutdownChildren.map((child) => waitForProcessGroupExit(child, POST_FORCE_KILL_WAIT_MS)),
        ),
      )
      .then(() => undefined);
    return shutdownPromise;
  };
  const signalHandlers = new Map();
  const signals =
    process.platform === "win32" ? ["SIGINT", "SIGTERM"] : ["SIGINT", "SIGTERM", "SIGHUP"];
  for (const signal of signals) {
    const handler = () => {
      if (shutdownPromise) {
        forceKillShutdownChildren();
        return;
      }
      void cleanup(signal, { waitForExit: true }).finally(() => {
        removeHandlers();
        process.kill(process.pid, signal);
      });
    };
    signalHandlers.set(signal, handler);
    process.on(signal, handler);
  }
  const exitHandler = () => {
    void cleanup("SIGTERM");
  };
  process.once("exit", exitHandler);

  return () => {
    if (shutdownPromise) {
      return;
    }
    active = false;
    removeHandlers();
  };
}

/**
 * Runs one boundary check with timeout and process-group termination.
 */
export function runSingleCheck(
  check,
  {
    activeChildren,
    checkTimeoutMs = DEFAULT_CHECK_TIMEOUT_MS,
    cwd,
    env,
    outputMaxBytes = DEFAULT_OUTPUT_MAX_BYTES,
  },
) {
  return new Promise((resolve) => {
    const resolvedCheckTimeoutMs = resolveTimerTimeoutMs(checkTimeoutMs);
    const startedAt = performance.now();
    const child = spawn(check.command, check.args, {
      cwd,
      env,
      detached: process.platform !== "win32",
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    activeChildren?.add(child);
    const output = createBoundedOutputBuffer(outputMaxBytes);
    let settled = false;
    let timedOut = false;
    let forceKillTimer = null;
    const finish = (code, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      if (forceKillTimer) {
        clearTimeout(forceKillTimer);
      }
      activeChildren?.delete(child);
      resolve({
        check,
        code: timedOut ? 1 : (code ?? 1),
        durationMs: Math.round(performance.now() - startedAt),
        signal,
        timedOut,
        output: output.read(),
      });
    };
    const finishAfterTimeoutTeardown = async (code, signal) => {
      await finishTerminatedProcessTree(child, TIMEOUT_KILL_GRACE_MS);
      finish(code, signal);
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      output.append(
        `\n[boundary-check] ${check.label} timed out after ${formatDuration(resolvedCheckTimeoutMs)}; terminating process group\n`,
      );
      terminateChild(child, "SIGTERM");
      forceKillTimer = setTimeout(() => {
        output.append(
          `[boundary-check] ${check.label} still running after ${formatDuration(TIMEOUT_KILL_GRACE_MS)}; sending SIGKILL\n`,
        );
        terminateChild(child, "SIGKILL");
      }, TIMEOUT_KILL_GRACE_MS);
      forceKillTimer.unref?.();
    }, resolvedCheckTimeoutMs);
    timeout.unref?.();

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => output.append(chunk));
    child.stderr.on("data", (chunk) => output.append(chunk));
    child.on("error", (error) => {
      output.append(`${error.stack ?? error.message}\n`);
      finish(1, null);
    });
    child.on("close", (code, signal) => {
      if (timedOut) {
        void finishAfterTimeoutTeardown(code, signal);
        return;
      }
      finish(code, signal);
    });
  });
}

function formatDuration(ms) {
  if (!Number.isFinite(ms)) {
    return "";
  }
  const roundedMs = ms < 1000 ? Math.round(ms) : Math.round(ms / 100) * 100;
  return prettyMilliseconds(Math.max(0, roundedMs), {
    unitCount: 1,
  });
}

function writeGroupedResult(result, output) {
  const success = result.code === 0;
  output.write(`::group::${result.check.label}\n`);
  output.write(`$ ${formatCommand(result.check)}\n`);
  if (result.output) {
    output.write(result.output.endsWith("\n") ? result.output : `${result.output}\n`);
  }
  if (success) {
    output.write(`[ok] ${result.check.label} in ${formatDuration(result.durationMs)}\n`);
  } else {
    const suffix = result.timedOut
      ? " (timeout)"
      : result.signal
        ? ` (signal ${result.signal})`
        : ` (exit ${result.code})`;
    output.write(
      `::error title=${result.check.label} failed::${result.check.label} failed${suffix} after ${formatDuration(result.durationMs)}\n`,
    );
  }
  output.write("::endgroup::\n");
}

function writeTimingSummary(results, output) {
  output.write("Additional boundary check timings:\n");
  for (const result of [...results].toSorted((left, right) => right.durationMs - left.durationMs)) {
    output.write(
      `${result.check.label.padEnd(48)} ${formatDuration(result.durationMs).padStart(8)}\n`,
    );
  }
}

/**
 * Runs boundary checks with bounded concurrency and returns the failure count.
 */
export async function runChecks(
  checks = BOUNDARY_CHECKS,
  {
    checkTimeoutMs = DEFAULT_CHECK_TIMEOUT_MS,
    concurrency = 4,
    cwd = process.cwd(),
    env = process.env,
    output = process.stdout,
    outputMaxBytes = DEFAULT_OUTPUT_MAX_BYTES,
  } = {},
) {
  const activeChildren = new Set();
  const removeActiveChildCleanup = installActiveChildCleanup(activeChildren);
  let results;

  try {
    results = await pMap(
      checks,
      (check) =>
        runSingleCheck(check, {
          activeChildren,
          checkTimeoutMs,
          cwd,
          env,
          outputMaxBytes,
        }),
      { concurrency, stopOnError: true },
    );
  } finally {
    removeActiveChildCleanup();
  }

  let failures = 0;
  for (const result of results) {
    writeGroupedResult(result, output);
    if (result.code !== 0) {
      failures += 1;
    }
  }
  writeTimingSummary(results, output);
  return failures;
}

function usage() {
  return `Usage: node scripts/run-additional-boundary-checks.mjs [--shard <N/TOTAL>[,<N/TOTAL>]]

Runs supplemental architecture and boundary checks with bounded concurrency.

Options:
  --shard <spec>    Run only checks selected by one or more N/TOTAL shard specs
  -h, --help        Show this help
`;
}

export function parseCliArgs(args, env = process.env) {
  let shardSpec = env.OPENCLAW_ADDITIONAL_BOUNDARY_SHARD ?? "";
  let help = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "-h" || arg === "--help") {
      help = true;
      continue;
    }
    if (arg === "--shard") {
      const value = args[index + 1];
      if (!value || value.startsWith("-")) {
        throw new Error("--shard requires a value");
      }
      shardSpec = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--shard=")) {
      const value = arg.slice("--shard=".length);
      if (!value) {
        throw new Error("--shard requires a value");
      }
      shardSpec = value;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return { help, shardSpec };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const cliArgs = parseCliArgs(process.argv.slice(2), process.env);
    if (cliArgs.help) {
      process.stdout.write(usage());
      process.exitCode = 0;
    } else {
      const concurrencyRaw =
        process.env.OPENCLAW_ADDITIONAL_BOUNDARY_CONCURRENCY ??
        process.env.OPENCLAW_EXTENSION_BOUNDARY_CONCURRENCY;
      const concurrencyLabel =
        process.env.OPENCLAW_ADDITIONAL_BOUNDARY_CONCURRENCY === undefined
          ? "OPENCLAW_EXTENSION_BOUNDARY_CONCURRENCY"
          : "OPENCLAW_ADDITIONAL_BOUNDARY_CONCURRENCY";
      const concurrency = resolveConcurrency(concurrencyRaw, 4, concurrencyLabel);
      const checkTimeoutMs = resolvePositiveInteger(
        process.env.OPENCLAW_ADDITIONAL_BOUNDARY_TIMEOUT_MS,
        DEFAULT_CHECK_TIMEOUT_MS,
        "OPENCLAW_ADDITIONAL_BOUNDARY_TIMEOUT_MS",
      );
      const outputMaxBytes = resolvePositiveInteger(
        process.env.OPENCLAW_ADDITIONAL_BOUNDARY_OUTPUT_MAX_BYTES,
        DEFAULT_OUTPUT_MAX_BYTES,
        "OPENCLAW_ADDITIONAL_BOUNDARY_OUTPUT_MAX_BYTES",
      );
      const shards = parseShardSelection(cliArgs.shardSpec);
      const checks = selectChecksForShard(BOUNDARY_CHECKS, shards);
      if (shards) {
        process.stdout.write(
          `Running ${checks.length}/${BOUNDARY_CHECKS.length} additional boundary checks (shard ${shards.map((shard) => shard.label).join(",")})\n`,
        );
      }
      const failures = await runChecks(checks, { checkTimeoutMs, concurrency, outputMaxBytes });
      process.exitCode = failures === 0 ? 0 : 1;
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${usage()}`);
    process.exitCode = 1;
  }
}
