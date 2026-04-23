#!/usr/bin/env node
import { spawn } from "node:child_process";

export const BOUNDARY_CHECKS = [
  ["plugin-extension-boundary", "pnpm", ["run", "lint:plugins:no-extension-imports"]],
  ["lint:tmp:no-random-messaging", "pnpm", ["run", "lint:tmp:no-random-messaging"]],
  ["lint:tmp:channel-agnostic-boundaries", "pnpm", ["run", "lint:tmp:channel-agnostic-boundaries"]],
  ["lint:tmp:tsgo-core-boundary", "pnpm", ["run", "lint:tmp:tsgo-core-boundary"]],
  ["lint:tmp:no-raw-channel-fetch", "pnpm", ["run", "lint:tmp:no-raw-channel-fetch"]],
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

export function formatCommand({ command, args }) {
  return [command, ...args].join(" ");
}

function runSingleCheck(check, { cwd, env }) {
  return new Promise((resolve) => {
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
      resolve({ check, code: 1, signal: null, output: chunks.join("") });
    });
    child.on("close", (code, signal) => {
      resolve({ check, code: code ?? 1, signal, output: chunks.join("") });
    });
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
    output.write(`[ok] ${result.check.label}\n`);
  } else {
    const suffix = result.signal ? ` (signal ${result.signal})` : ` (exit ${result.code})`;
    output.write(
      `::error title=${result.check.label} failed::${result.check.label} failed${suffix}\n`,
    );
  }
  output.write("::endgroup::\n");
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
  return failures;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const concurrency = resolveConcurrency(
    process.env.OPENCLAW_ADDITIONAL_BOUNDARY_CONCURRENCY ??
      process.env.OPENCLAW_EXTENSION_BOUNDARY_CONCURRENCY,
  );
  const failures = await runChecks(BOUNDARY_CHECKS, { concurrency });
  process.exitCode = failures === 0 ? 0 : 1;
}
