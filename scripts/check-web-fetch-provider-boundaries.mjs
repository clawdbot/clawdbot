#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";
import { collectSourceFileContents } from "./lib/source-file-scan-cache.mjs";
import { runAsScript } from "./lib/ts-guard-utils.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scanExtensions = new Set([".ts", ".js", ".mjs", ".cjs"]);
const ignoredDirNames = new Set([
  ".artifacts",
  ".git",
  ".turbo",
  "build",
  "coverage",
  "dist",
  "extensions",
  "node_modules",
]);
const allowedFiles = new Set([
  "src/agents/tools/web-fetch.test-harness.ts",
  "src/config/legacy-web-fetch.ts",
  "src/config/zod-schema.agent-runtime.ts",
  "src/secrets/target-registry-data.ts",
]);
const suspiciousPatterns = [
  /fetchFirecrawlContent/,
  /firecrawl-fetch-provider\.js/,
  /createFirecrawlWebFetchProvider/,
  /providerId:\s*"firecrawl"/,
  /provider:\s*"firecrawl"/,
  /id:\s*"firecrawl"/,
];

let webFetchProviderViolationsPromise;

export async function collectWebFetchProviderBoundaryViolations() {
  if (!webFetchProviderViolationsPromise) {
    webFetchProviderViolationsPromise = (async () => {
      const violations = [];
      const files = await collectSourceFileContents({
        repoRoot,
        scanRoots: ["src"],
        scanExtensions,
        ignoredDirNames,
      });
      for (const { relativeFile, content } of files) {
        if (
          allowedFiles.has(relativeFile) ||
          relativeFile.includes(".test.") ||
          relativeFile.includes("test-support")
        ) {
          continue;
        }
        const lines = content.split(/\r?\n/);
        for (const [index, line] of lines.entries()) {
          if (!line.includes("firecrawl") && !line.includes("Firecrawl")) {
            continue;
          }
          if (!suspiciousPatterns.some((pattern) => pattern.test(line))) {
            continue;
          }
          violations.push({
            file: relativeFile,
            line: index + 1,
            reason: "core web-fetch runtime/tooling contains Firecrawl-specific fetch logic",
          });
        }
      }
      return violations.toSorted(
        (left, right) => left.file.localeCompare(right.file) || left.line - right.line,
      );
    })();
    try {
      return await webFetchProviderViolationsPromise;
    } catch (error) {
      webFetchProviderViolationsPromise = undefined;
      throw error;
    }
  }
  return await webFetchProviderViolationsPromise;
}

export async function main(argv = process.argv.slice(2), io) {
  const json = argv.includes("--json");
  const violations = await collectWebFetchProviderBoundaryViolations();
  const writeStdout = (chunk) => {
    if (io?.stdout?.write) {
      io.stdout.write(chunk);
      return;
    }
    process.stdout.write(chunk);
  };
  const writeStderr = (chunk) => {
    if (io?.stderr?.write) {
      io.stderr.write(chunk);
      return;
    }
    process.stderr.write(chunk);
  };
  if (json) {
    writeStdout(`${JSON.stringify(violations, null, 2)}\n`);
  } else if (violations.length > 0) {
    for (const violation of violations) {
      writeStderr(`${violation.file}:${violation.line} ${violation.reason}\n`);
    }
  }
  return violations.length === 0 ? 0 : 1;
}

runAsScript(import.meta.url, async (argv, io) => {
  const exitCode = await main(argv, io);
  if (!io && exitCode !== 0) {
    process.exit(exitCode);
  }
  return exitCode;
});
