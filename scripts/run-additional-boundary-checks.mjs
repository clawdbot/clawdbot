#!/usr/bin/env node
import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";

const DEFAULT_CHECK_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_OUTPUT_MAX_BYTES = 512 * 1024;
const TIMEOUT_KILL_GRACE_MS = 5_000;

export const BOUNDARY_CHECKS = [
  ["prompt:snapshots:check", "pnpm", ["prompt:snapshots:check"]],
  ["plugin-extension-boundary", "pnpm", ["run", "lint:plugins:no-extension-imports"]],
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
].map(([label, command, args]) => ({ label, command, args }));

export function resolveConcurrency(value, fallback = 4) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return fallback;
  }
  return parsed;
}

export function resolvePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return fallback;
  }
  return parsed;
}

export function parseShardSpec(value) {
  if (!value) {
    return null;
  }
  const match = String(value).match(/^(\d+)\/(\d+)$/u);
  if (!match) {
    throw new Error(`Invalid shard spec '${value}' (expected N/TOTAL)`);
  }
  const index = Number.parseInt(match[1], 10);
  const count = Number.parseInt(match[2], 10);
  if (
    !Number.isInteger(index) ||
    !Number.isInteger(count) ||
    index < 1 ||
    count < 1 ||
    index > count
  ) {
    throw new Error(`Invalid shard spec '${value}' (expected 1 <= N <= TOTAL)`);
  }
  return { count, index: index - 1, label: `${index}/${count}` };
}

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

export function formatCommand({ command, args }) {
  return [command, ...args].join(" ");
}

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
      const tail = buffer.subarray(buffer.length - limit).toString("utf8");
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
      const tail = buffer.subarray(overflow).toString("utf8");
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

function terminateActiveChildren(activeChildren, signal) {
  for (const child of activeChildren) {
    terminateChild(child, signal);
  }
}

function installActiveChildCleanup(activeChildren) {
  let active = true;
  const removeHandlers = () => {
    for (const [signal, handler] of signalHandlers) {
      process.off(signal, handler);
    }
    process.off("exit", exitHandler);
  };
  const cleanup = (signal) => {
    if (!active) {
      return;
    }
    active = false;
    terminateActiveChildren(activeChildren, signal);
  };
  const signalHandlers = new Map();
  const signals =
    process.platform === "win32" ? ["SIGINT", "SIGTERM"] : ["SIGINT", "SIGTERM", "SIGHUP"];
  for (const signal of signals) {
    const handler = () => {
      cleanup(signal);
      removeHandlers();
      process.kill(process.pid, signal);
    };
    signalHandlers.set(signal, handler);
    process.once(signal, handler);
  }
  const exitHandler = () => {
    cleanup("SIGTERM");
  };
  process.once("exit", exitHandler);

  return () => {
    active = false;
    removeHandlers();
  };
}

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
    const timeout = setTimeout(() => {
      timedOut = true;
      output.append(
        `\n[boundary-check] ${check.label} timed out after ${formatDuration(checkTimeoutMs)}; terminating process group\n`,
      );
      terminateChild(child, "SIGTERM");
      forceKillTimer = setTimeout(() => {
        output.append(
          `[boundary-check] ${check.label} still running after ${formatDuration(TIMEOUT_KILL_GRACE_MS)}; sending SIGKILL\n`,
        );
        terminateChild(child, "SIGKILL");
      }, TIMEOUT_KILL_GRACE_MS);
      forceKillTimer.unref?.();
    }, checkTimeoutMs);
    timeout.unref?.();

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => output.append(chunk));
    child.stderr.on("data", (chunk) => output.append(chunk));
    child.on("error", (error) => {
      output.append(`${error.stack ?? error.message}\n`);
      finish(1, null);
    });
    child.on("close", (code, signal) => finish(code, signal));
  });
}

function formatDuration(ms) {
  if (!Number.isFinite(ms)) {
    return "";
  }
  if (ms < 1000) {
    return `${ms}ms`;
  }
  return `${(ms / 1000).toFixed(1)}s`;
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
  const results = Array.from({ length: checks.length });
  const activeChildren = new Set();
  const removeActiveChildCleanup = installActiveChildCleanup(activeChildren);
  let nextIndex = 0;
  let active = 0;

  try {
    await new Promise((resolve) => {
      const launch = () => {
        if (nextIndex >= checks.length && active === 0) {
          resolve();
          return;
        }

        while (active < concurrency && nextIndex < checks.length) {
          const index = nextIndex;
          const check = checks[nextIndex++];
          active += 1;
          void runSingleCheck(check, {
            activeChildren,
            checkTimeoutMs,
            cwd,
            env,
            outputMaxBytes,
          })
            .then((result) => {
              results[index] = result;
            })
            .finally(() => {
              active -= 1;
              launch();
            });
        }
      };

      launch();
    });
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

function resolveCliShardSpec(args, env) {
  const shardIndex = args.indexOf("--shard");
  if (shardIndex !== -1) {
    return args[shardIndex + 1] ?? "";
  }
  const inlineShard = args.find((arg) => arg.startsWith("--shard="));
  if (inlineShard) {
    return inlineShard.slice("--shard=".length);
  }
  return env.OPENCLAW_ADDITIONAL_BOUNDARY_SHARD ?? "";
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const concurrency = resolveConcurrency(
    process.env.OPENCLAW_ADDITIONAL_BOUNDARY_CONCURRENCY ??
      process.env.OPENCLAW_EXTENSION_BOUNDARY_CONCURRENCY,
  );
  const checkTimeoutMs = resolvePositiveInteger(
    process.env.OPENCLAW_ADDITIONAL_BOUNDARY_TIMEOUT_MS,
    DEFAULT_CHECK_TIMEOUT_MS,
  );
  const outputMaxBytes = resolvePositiveInteger(
    process.env.OPENCLAW_ADDITIONAL_BOUNDARY_OUTPUT_MAX_BYTES,
    DEFAULT_OUTPUT_MAX_BYTES,
  );
  const shards = parseShardSelection(resolveCliShardSpec(process.argv.slice(2), process.env));
  const checks = selectChecksForShard(BOUNDARY_CHECKS, shards);
  if (shards) {
    process.stdout.write(
      `Running ${checks.length}/${BOUNDARY_CHECKS.length} additional boundary checks (shard ${shards.map((shard) => shard.label).join(",")})\n`,
    );
  }
  const failures = await runChecks(checks, { checkTimeoutMs, concurrency, outputMaxBytes });
  process.exitCode = failures === 0 ? 0 : 1;
}
