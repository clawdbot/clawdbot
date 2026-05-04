#!/usr/bin/env node
import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";

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
  ["lint:ui:no-raw-window-open", "pnpm", ["lint:ui:no-raw-window-open"]],
].map(([label, command, args]) => ({ label, command, args }));

export function resolveConcurrency(value, fallback = 4) {
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

export function selectChecksForShard(checks, shardSpec) {
  const shard = typeof shardSpec === "string" ? parseShardSpec(shardSpec) : shardSpec;
  if (!shard) {
    return checks;
  }
  return checks.filter((_check, index) => index % shard.count === shard.index);
}

export function formatCommand({ command, args }) {
  return [command, ...args].join(" ");
}

function runSingleCheck(check, { cwd, env }) {
  return new Promise((resolve) => {
    const startedAt = performance.now();
    const child = spawn(check.command, check.args, {
      cwd,
      env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks = [];

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.stderr.on("data", (chunk) => chunks.push(chunk));
    child.on("error", (error) => {
      chunks.push(`${error.stack ?? error.message}\n`);
      resolve({
        check,
        code: 1,
        durationMs: Math.round(performance.now() - startedAt),
        signal: null,
        output: chunks.join(""),
      });
    });
    child.on("close", (code, signal) => {
      resolve({
        check,
        code: code ?? 1,
        durationMs: Math.round(performance.now() - startedAt),
        signal,
        output: chunks.join(""),
      });
    });
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
    const suffix = result.signal ? ` (signal ${result.signal})` : ` (exit ${result.code})`;
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
  { concurrency = 4, cwd = process.cwd(), env = process.env, output = process.stdout } = {},
) {
  const results = Array.from({ length: checks.length });
  let nextIndex = 0;
  let active = 0;

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
        void runSingleCheck(check, { cwd, env })
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
  const shard = parseShardSpec(resolveCliShardSpec(process.argv.slice(2), process.env));
  const checks = selectChecksForShard(BOUNDARY_CHECKS, shard);
  if (shard) {
    process.stdout.write(
      `Running ${checks.length}/${BOUNDARY_CHECKS.length} additional boundary checks (shard ${shard.label})\n`,
    );
  }
  const failures = await runChecks(checks, { concurrency });
  process.exitCode = failures === 0 ? 0 : 1;
}
