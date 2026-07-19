#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  RetryableReadbackError,
  verifyPublishedClawHubPackage,
} from "./verify-clawhub-published-artifact.mjs";

const DEFAULT_ATTEMPTS = 54;
const DEFAULT_CONCURRENCY = 8;
const DEFAULT_DELAY_MS = 30_000;
const MAX_ATTEMPTS = 60;
const MAX_CONCURRENCY = 16;
const MAX_DELAY_MS = 60_000;

export class ClawHubBatchVerificationError extends Error {
  constructor(message, evidence) {
    super(message);
    this.evidence = evidence;
  }
}

function positiveInteger(value, fallback, label, maximum) {
  const text = String(value ?? fallback);
  if (!/^[1-9][0-9]*$/u.test(text)) {
    throw new Error(`${label} must be an integer from 1 through ${maximum}.`);
  }
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed > maximum) {
    throw new Error(`${label} must be an integer from 1 through ${maximum}.`);
  }
  return parsed;
}

function readPlan(path) {
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(parsed)) {
    throw new Error("ClawHub batch plan must be a JSON array.");
  }
  return parsed.map((plugin) => {
    for (const key of ["artifactName", "packageName", "publishTag", "version"]) {
      if (typeof plugin?.[key] !== "string" || plugin[key].trim() !== plugin[key] || !plugin[key]) {
        throw new Error(`ClawHub batch plan entry has invalid ${key}.`);
      }
    }
    return plugin;
  });
}

async function mapWithConcurrency(items, concurrency, operation) {
  const results = Array.from({ length: items.length });
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      try {
        results[index] = { status: "fulfilled", value: await operation(items[index]) };
      } catch (error) {
        results[index] = { status: "rejected", reason: error };
      }
    }
  });
  await Promise.all(workers);
  return results;
}

export async function verifyClawHubReleaseBatch(options) {
  const attempts = positiveInteger(options.attempts, DEFAULT_ATTEMPTS, "attempts", MAX_ATTEMPTS);
  const concurrency = positiveInteger(
    options.concurrency,
    DEFAULT_CONCURRENCY,
    "concurrency",
    MAX_CONCURRENCY,
  );
  const delayMs = positiveInteger(options.delayMs, DEFAULT_DELAY_MS, "delayMs", MAX_DELAY_MS);
  const sleep =
    options.sleep ??
    ((milliseconds) =>
      new Promise((resolveDelay) => {
        setTimeout(resolveDelay, milliseconds);
      }));
  const verify =
    options.verify ??
    ((plugin) =>
      verifyPublishedClawHubPackage({
        expectedArtifactDir: join(options.artifactsRoot, plugin.artifactName),
        packageName: plugin.packageName,
        packageVersion: plugin.version,
        publishTag: plugin.publishTag,
        registry: options.registry,
        retryOptions: { attempts: 1, delayMs: 1 },
      }));
  const startedAt = Date.now();
  const completed = new Map();
  let pending = [...options.plugins];
  let lastRetryableErrors = new Map();

  const buildEvidence = (status, failures = new Map(), failureStatus = "failed") => ({
    schemaVersion: 1,
    status,
    packageCount: options.plugins.length,
    durationMs: Date.now() - startedAt,
    packages: options.plugins.map((plugin) => {
      const failure = failures.get(plugin.packageName);
      const isReady = completed.has(plugin.packageName);
      const result = completed.get(plugin.packageName);
      return {
        artifactName: plugin.artifactName,
        packageName: plugin.packageName,
        publishTag: plugin.publishTag,
        version: plugin.version,
        status: isReady ? "ready" : failure ? failureStatus : "pending",
        ...(isReady ? { result } : {}),
        ...(failure ? { error: failure.message } : {}),
      };
    }),
  });

  for (let attempt = 1; attempt <= attempts && pending.length > 0; attempt += 1) {
    const round = await mapWithConcurrency(pending, concurrency, verify);
    const retry = [];
    const permanentFailures = new Map();
    lastRetryableErrors = new Map();
    for (let index = 0; index < pending.length; index += 1) {
      const plugin = pending[index];
      const result = round[index];
      if (result.status === "fulfilled") {
        completed.set(plugin.packageName, result.value);
        continue;
      }
      if (!(result.reason instanceof RetryableReadbackError)) {
        permanentFailures.set(
          plugin.packageName,
          result.reason instanceof Error ? result.reason : new Error(String(result.reason)),
        );
        continue;
      }
      retry.push(plugin);
      lastRetryableErrors.set(plugin.packageName, result.reason);
    }
    if (permanentFailures.size > 0) {
      const details = [...permanentFailures.entries()]
        .map(([packageName, error]) => `${packageName}: ${error.message}`)
        .join("\n");
      throw new ClawHubBatchVerificationError(
        `ClawHub batch verification failed permanently:\n${details}`,
        buildEvidence("failed", permanentFailures),
      );
    }
    pending = retry;
    console.log(
      `ClawHub batch verification ${attempt}/${attempts}: ready=${completed.size} pending=${pending.length}`,
    );
    if (pending.length > 0 && attempt < attempts) {
      const requestedDelayMs = Math.max(
        delayMs,
        ...[...lastRetryableErrors.values()].map((error) => error.retryAfterMs ?? 0),
      );
      await sleep(Math.min(requestedDelayMs, MAX_DELAY_MS));
    }
  }

  if (pending.length > 0) {
    const details = pending
      .map((plugin) => {
        const error = lastRetryableErrors.get(plugin.packageName);
        return `${plugin.packageName}@${plugin.version}: ${error?.message ?? "not ready"}`;
      })
      .join("\n");
    throw new ClawHubBatchVerificationError(
      `ClawHub batch did not converge after ${attempts} attempts (${pending.length} pending):\n${details}`,
      buildEvidence("failed", lastRetryableErrors, "pending"),
    );
  }

  return buildEvidence("ecosystem-converged");
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined) {
      throw new Error(`Invalid argument: ${String(flag)}`);
    }
    args[flag.slice(2).replaceAll("-", "_")] = value;
  }
  if (!args.plan || !args.artifacts_root) {
    throw new Error(
      "Usage: verify-clawhub-release-batch --plan <json> --artifacts-root <dir> [--output <json>] [--registry <url>]",
    );
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let evidence;
  try {
    evidence = await verifyClawHubReleaseBatch({
      plugins: readPlan(args.plan),
      artifactsRoot: args.artifacts_root,
      registry: args.registry ?? "https://clawhub.ai",
      attempts: process.env.OPENCLAW_CLAWHUB_VERIFY_ATTEMPTS,
      concurrency: process.env.OPENCLAW_CLAWHUB_VERIFY_CONCURRENCY,
      delayMs: process.env.OPENCLAW_CLAWHUB_VERIFY_DELAY_MS,
    });
  } catch (error) {
    if (args.output && error instanceof ClawHubBatchVerificationError) {
      await mkdir(dirname(args.output), { recursive: true });
      await writeFile(args.output, `${JSON.stringify(error.evidence, null, 2)}\n`, "utf8");
    }
    throw error;
  }
  if (args.output) {
    await mkdir(dirname(args.output), { recursive: true });
    await writeFile(args.output, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  }
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main().catch(
    /** @param {unknown} error */ (error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    },
  );
}
