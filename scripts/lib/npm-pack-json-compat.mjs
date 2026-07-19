#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { closeSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export function normalizeNpmPackJson(raw) {
  const parsed = JSON.parse(raw);
  if (Array.isArray(parsed)) {
    return parsed;
  }
  if (parsed && typeof parsed === "object") {
    return Object.values(parsed);
  }
  throw new Error("npm pack JSON must be an array or keyed object");
}

function run() {
  const npmCli = process.env.OPENCLAW_REAL_NPM_CLI?.trim();
  if (!npmCli) {
    console.error("OPENCLAW_REAL_NPM_CLI is required");
    process.exit(2);
  }

  const args = process.argv.slice(2);
  const normalize = args[0] === "pack" && args.includes("--json");
  const outputDir = normalize ? mkdtempSync(join(tmpdir(), "openclaw-npm-pack-json-")) : undefined;
  const outputPath = outputDir ? join(outputDir, "stdout.json") : undefined;
  let outputFd = outputPath ? openSync(outputPath, "w") : undefined;
  try {
    const result = spawnSync(npmCli, args, {
      env: process.env,
      stdio: normalize ? ["inherit", outputFd, "inherit"] : "inherit",
    });
    if (result.error) {
      console.error(result.error.message);
      process.exitCode = 1;
      return;
    }
    if (outputFd !== undefined) {
      closeSync(outputFd);
      outputFd = undefined;
    }
    const stdout = outputPath ? readFileSync(outputPath, "utf8") : "";
    if (result.status !== 0) {
      if (stdout) {
        process.stdout.write(stdout);
      }
      process.exitCode = result.status ?? 1;
      return;
    }
    if (!normalize) {
      return;
    }

    try {
      process.stdout.write(`${JSON.stringify(normalizeNpmPackJson(stdout))}\n`);
    } catch (error) {
      console.error(
        `failed to normalize npm pack JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
      process.exitCode = 1;
    }
  } finally {
    if (outputFd !== undefined) {
      try {
        closeSync(outputFd);
      } catch {}
    }
    if (outputDir) {
      rmSync(outputDir, { force: true, recursive: true });
    }
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run();
}
