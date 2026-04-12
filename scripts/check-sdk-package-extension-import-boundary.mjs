#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { BUNDLED_PLUGIN_PATH_PREFIX } from "./lib/bundled-plugin-paths.mjs";
import {
  collectTypeScriptInventory,
  normalizeRepoPath,
  resolveRepoSpecifier,
  visitModuleSpecifiers,
  writeLine,
} from "./lib/guard-inventory-utils.mjs";
import {
  collectTypeScriptFilesFromRoots,
  resolveSourceRoots,
  runAsScript,
  toLine,
} from "./lib/ts-guard-utils.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scanRoots = resolveSourceRoots(repoRoot, ["src/plugin-sdk", "packages"]);
let cachedInventoryPromise = null;

function compareEntries(left, right) {
  return (
    left.file.localeCompare(right.file) ||
    left.line - right.line ||
    left.kind.localeCompare(right.kind) ||
    left.specifier.localeCompare(right.specifier) ||
    left.reason.localeCompare(right.reason)
  );
}

function classifyResolvedExtensionReason(kind) {
  const verb =
    kind === "export"
      ? "re-exports"
      : kind === "dynamic-import"
        ? "dynamically imports"
        : "imports";
  return `${verb} bundled plugin file from sdk/package boundary`;
}

function shouldSkipFile(filePath) {
  const relativeFile = normalizeRepoPath(repoRoot, filePath);
  return relativeFile.startsWith("packages/plugin-sdk/dist/");
}

function shouldParseSource(source) {
  return source.includes(BUNDLED_PLUGIN_PATH_PREFIX);
}

function scanImportBoundaryViolations(sourceFile, filePath) {
  const entries = [];
  const relativeFile = normalizeRepoPath(repoRoot, filePath);

  visitModuleSpecifiers(ts, sourceFile, ({ kind, specifier, specifierNode }) => {
    const resolvedPath = resolveRepoSpecifier(repoRoot, specifier, filePath);
    if (!resolvedPath?.startsWith(BUNDLED_PLUGIN_PATH_PREFIX)) {
      return;
    }
    entries.push({
      file: relativeFile,
      line: toLine(sourceFile, specifierNode),
      kind,
      specifier,
      resolvedPath,
      reason: classifyResolvedExtensionReason(kind),
    });
  });

  return entries;
}

export async function collectSdkPackageExtensionImportBoundaryInventory() {
  if (cachedInventoryPromise) {
    return cachedInventoryPromise;
  }

  cachedInventoryPromise = (async () => {
    const files = (await collectTypeScriptFilesFromRoots(scanRoots))
      .filter((filePath) => !shouldSkipFile(filePath))
      .toSorted((left, right) =>
        normalizeRepoPath(repoRoot, left).localeCompare(normalizeRepoPath(repoRoot, right)),
      );
    return await collectTypeScriptInventory({
      ts,
      files,
      compareEntries,
      collectEntries(sourceFile, filePath) {
        return scanImportBoundaryViolations(sourceFile, filePath);
      },
      shouldParseSource,
    });
  })();

  try {
    return await cachedInventoryPromise;
  } catch (error) {
    cachedInventoryPromise = null;
    throw error;
  }
}

function formatInventoryHuman(inventory) {
  if (inventory.length === 0) {
    return "Rule: src/plugin-sdk/** and packages/** must not import bundled plugin files\nNo sdk/package import boundary violations found.";
  }

  const lines = [
    "Rule: src/plugin-sdk/** and packages/** must not import bundled plugin files",
    "SDK/package extension import boundary inventory:",
  ];
  let activeFile = "";
  for (const entry of inventory) {
    if (entry.file !== activeFile) {
      activeFile = entry.file;
      lines.push(activeFile);
    }
    lines.push(`  - line ${entry.line} [${entry.kind}] ${entry.reason}`);
    lines.push(`    specifier: ${entry.specifier}`);
    lines.push(`    resolved: ${entry.resolvedPath}`);
  }
  return lines.join("\n");
}

export async function main(argv = process.argv.slice(2), io) {
  const streams = io ?? { stdout: process.stdout, stderr: process.stderr };
  const json = argv.includes("--json");
  const inventory = await collectSdkPackageExtensionImportBoundaryInventory();

  if (json) {
    writeLine(streams.stdout, JSON.stringify(inventory, null, 2));
  } else {
    writeLine(streams.stdout, formatInventoryHuman(inventory));
    writeLine(
      streams.stdout,
      inventory.length === 0 ? "Boundary is clean." : "Boundary has violations.",
    );
  }

  return inventory.length === 0 ? 0 : 1;
}

runAsScript(import.meta.url, main);
