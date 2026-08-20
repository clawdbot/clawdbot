#!/usr/bin/env node

// Checks core web-fetch surfaces for provider-owned Firecrawl coupling.
import { resolveRepoRoot } from "./lib/repo-root.mjs";
import { collectSourceFileContents } from "./lib/source-file-scan-cache.mts";
import { runAsScript } from "./lib/ts-guard-utils.mts";
const repoRoot = resolveRepoRoot(import.meta.url);
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

async function scanWebFetchProviderBoundaryViolations() {
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
}

let webFetchProviderViolationsPromise:
  | ReturnType<typeof scanWebFetchProviderBoundaryViolations>
  | undefined;

/**
 * Collects web-fetch provider boundary violations in core source files.
 */
async function collectWebFetchProviderBoundaryViolations() {
  if (!webFetchProviderViolationsPromise) {
    webFetchProviderViolationsPromise = scanWebFetchProviderBoundaryViolations();
    try {
      return await webFetchProviderViolationsPromise;
    } catch (error) {
      webFetchProviderViolationsPromise = undefined;
      throw error;
    }
  }
  return await webFetchProviderViolationsPromise;
}

/** Runs the web-fetch provider boundary check. */
async function main() {
  const violations = await collectWebFetchProviderBoundaryViolations();
  for (const violation of violations) {
    process.stderr.write(`${violation.file}:${violation.line} ${violation.reason}\n`);
  }
  return violations.length === 0 ? 0 : 1;
}

runAsScript(import.meta.url, async () => {
  const exitCode = await main();
  if (exitCode !== 0) {
    process.exit(exitCode);
  }
  return exitCode;
});
