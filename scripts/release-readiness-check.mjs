#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

export const RELEASE_READINESS_STAGES = [
  { id: "diff", command: "git", args: ["diff", "--check"] },
  { id: "generated", command: "pnpm", args: ["release:generated:check"] },
  { id: "plugin-sync", command: "pnpm", args: ["plugins:sync:check"] },
  {
    id: "plugin-npm-metadata",
    command: "pnpm",
    args: ["release:plugins:npm:check", "--", "--selection-mode", "all-publishable"],
  },
  {
    id: "plugin-clawhub-metadata",
    command: "pnpm",
    args: ["release:plugins:clawhub:check", "--", "--selection-mode", "all-publishable"],
  },
  {
    id: "plugin-pack",
    command: "node",
    args: ["--import", "tsx", "scripts/plugin-release-pretag-pack-check.ts"],
  },
  { id: "temp-paths", command: "pnpm", args: ["check:temp-path-guardrails"] },
  { id: "workflows", command: "pnpm", args: ["check:workflows"] },
];

function runStage(stage) {
  const startedAt = Date.now();
  return new Promise((resolvePromise) => {
    const child = spawn(stage.command, stage.args, { stdio: "inherit" });
    child.once("error", (error) => {
      resolvePromise({
        id: stage.id,
        status: "failed",
        durationMs: Date.now() - startedAt,
        error: error.message,
      });
    });
    child.once("exit", (code, signal) => {
      resolvePromise({
        id: stage.id,
        status: code === 0 ? "passed" : "failed",
        durationMs: Date.now() - startedAt,
        ...(code === 0 ? {} : { error: `exit=${code ?? signal ?? "unknown"}` }),
      });
    });
  });
}

export async function runReleaseReadiness(stages = RELEASE_READINESS_STAGES, options = {}) {
  const concurrency = options.concurrency ?? 4;
  const results = new Array(stages.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, stages.length) }, async () => {
    while (nextIndex < stages.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await (options.runStage ?? runStage)(stages[index]);
    }
  });
  const startedAt = Date.now();
  await Promise.all(workers);
  return {
    schemaVersion: 1,
    status: results.every((result) => result.status === "passed") ? "passed" : "failed",
    durationMs: Date.now() - startedAt,
    stages: results,
  };
}

function parseArgs(argv) {
  const options = { output: "", concurrency: 4 };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--output") {
      options.output = argv[++index] ?? "";
      continue;
    }
    if (arg === "--concurrency") {
      options.concurrency = Number(argv[++index]);
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  if (
    !Number.isInteger(options.concurrency) ||
    options.concurrency < 1 ||
    options.concurrency > 8
  ) {
    throw new Error("--concurrency must be an integer from 1 through 8");
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = await runReleaseReadiness(RELEASE_READINESS_STAGES, options);
  if (options.output) {
    await mkdir(dirname(options.output), { recursive: true });
    await writeFile(options.output, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.status !== "passed") {
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
