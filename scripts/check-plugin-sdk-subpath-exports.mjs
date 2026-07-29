#!/usr/bin/env node

// Verifies plugin SDK subpath exports and generated entrypoint metadata.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { normalizeRepoPath, visitModuleSpecifiers } from "./lib/guard-inventory-utils.mjs";
import {
  collectTypeScriptFilesFromRoots,
  resolveSourceRoots,
  toLine,
} from "./lib/ts-guard-utils.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scanRoots = resolveSourceRoots(repoRoot, [
  "src",
  "packages",
  "extensions",
  "scripts",
  "test",
]);

function readPackageExports() {
  const packageJson = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  return new Set(
    Object.keys(packageJson.exports ?? {})
      .filter((key) => key.startsWith("./plugin-sdk/"))
      .map((key) => key.slice("./plugin-sdk/".length)),
  );
}

function readEntrypoints() {
  const entrypoints = JSON.parse(
    readFileSync(path.join(repoRoot, "scripts/lib/plugin-sdk-entrypoints.json"), "utf8"),
  );
  return new Set(entrypoints.filter((entry) => entry !== "index"));
}

function readPrivateLocalOnlySubpaths() {
  const subpaths = JSON.parse(
    readFileSync(
      path.join(repoRoot, "scripts/lib/plugin-sdk-private-local-only-subpaths.json"),
      "utf8",
    ),
  );
  return new Set(subpaths.filter((entry) => typeof entry === "string" && !entry.includes("/")));
}

function parsePluginSdkSubpath(specifier) {
  if (!specifier.startsWith("openclaw/plugin-sdk/")) {
    return null;
  }
  const subpath = specifier.slice("openclaw/plugin-sdk/".length);
  return subpath || null;
}

function isGeneratedBuildArtifact(filePath) {
  return normalizeRepoPath(repoRoot, filePath).split("/").includes("dist");
}

function isRuntimeModuleReference(node) {
  // With verbatimModuleSyntax, inline `type` specifiers emit an empty import/export and still
  // resolve the module. Only declaration-level `import type` and `export type` are erased.
  if (ts.isImportDeclaration(node)) {
    return !node.importClause?.isTypeOnly;
  }
  if (ts.isExportDeclaration(node)) {
    return !node.isTypeOnly;
  }
  if (ts.isImportTypeNode(node)) {
    return false;
  }
  if (ts.isImportEqualsDeclaration(node)) {
    return !node.isTypeOnly;
  }
  return true;
}

function compareEntries(left, right) {
  return (
    left.file.localeCompare(right.file) ||
    left.line - right.line ||
    left.kind.localeCompare(right.kind) ||
    left.specifier.localeCompare(right.specifier) ||
    left.subpath.localeCompare(right.subpath)
  );
}

async function collectViolations() {
  const entrypoints = readEntrypoints();
  const exports = readPackageExports();
  const privateLocalOnlySubpaths = readPrivateLocalOnlySubpaths();
  // Workspace packages resolve private facades through root TS paths and bundle them into dist;
  // live jiti source stages inject the same private map. Core src callers must stay relative.
  const coreRuntimeFiles = new Set(
    (
      await collectTypeScriptFilesFromRoots(resolveSourceRoots(repoRoot, ["src"]), {
        includeTests: false,
        extraTestSuffixes: [".test-support.ts", ".test-loader.ts", ".test-fixtures.ts"],
      })
    ).filter((filePath) => !isGeneratedBuildArtifact(filePath)),
  );
  const files = (await collectTypeScriptFilesFromRoots(scanRoots, { includeTests: true }))
    .filter((filePath) => !isGeneratedBuildArtifact(filePath))
    .toSorted((left, right) =>
      normalizeRepoPath(repoRoot, left).localeCompare(normalizeRepoPath(repoRoot, right)),
    );
  const violations = [];

  for (const filePath of files) {
    const sourceText = readFileSync(filePath, "utf8");
    const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true);

    function push(kind, node, specifierNode, specifier) {
      const subpath = parsePluginSdkSubpath(specifier);
      if (!subpath) {
        return;
      }
      if (privateLocalOnlySubpaths.has(subpath)) {
        const repoPath = normalizeRepoPath(repoRoot, filePath);
        if (coreRuntimeFiles.has(filePath) && isRuntimeModuleReference(node)) {
          violations.push({
            file: repoPath,
            line: toLine(sourceFile, specifierNode),
            kind,
            specifier,
            subpath,
            reason: "private runtime helper used by core must use a relative import",
          });
        }
        return;
      }

      const missingFrom = [];
      if (!entrypoints.has(subpath)) {
        missingFrom.push("scripts/lib/plugin-sdk-entrypoints.json");
      }
      if (!exports.has(subpath)) {
        missingFrom.push("package.json exports");
      }
      if (missingFrom.length === 0) {
        return;
      }

      violations.push({
        file: normalizeRepoPath(repoRoot, filePath),
        line: toLine(sourceFile, specifierNode),
        kind,
        specifier,
        subpath,
        reason: `missing from ${missingFrom.join(" and ")}`,
      });
    }

    visitModuleSpecifiers(ts, sourceFile, ({ kind, node, specifier, specifierNode }) => {
      push(kind, node, specifierNode, specifier);
    });
  }

  return violations.toSorted(compareEntries);
}

async function main() {
  const violations = await collectViolations();
  if (violations.length === 0) {
    console.log("OK: all referenced openclaw/plugin-sdk/<subpath> imports are exported.");
    return;
  }

  console.error(
    "Rule: every referenced openclaw/plugin-sdk/<subpath> must be public or use its required private boundary.",
  );
  for (const violation of violations) {
    console.error(
      `- ${violation.file}:${violation.line} [${violation.kind}] ${violation.specifier}: ${violation.reason}`,
    );
  }
  process.exit(1);
}

main().catch(
  /** @param {unknown} error */ (error) => {
    console.error(error);
    process.exit(1);
  },
);
