#!/usr/bin/env node

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { BUNDLED_PLUGIN_PATH_PREFIX } from "./lib/bundled-plugin-paths.mjs";
import {
  collectTypeScriptInventory,
  createCachedAsync,
  diffInventoryEntries,
  formatGroupedInventoryHuman,
  normalizeRepoPath,
  runBaselineInventoryCheck,
  resolveRepoSpecifier,
  visitModuleSpecifiers,
} from "./lib/guard-inventory-utils.mjs";
import {
  collectTypeScriptFilesFromRoots,
  resolveSourceRoots,
  runAsScript,
  toLine,
} from "./lib/ts-guard-utils.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scanRoots = resolveSourceRoots(repoRoot, ["src/plugins"]);
const baselinePath = path.join(
  repoRoot,
  "test",
  "fixtures",
  "plugin-extension-import-boundary-inventory.json",
);

const bundledWebSearchProviders = new Set([
  "brave",
  "firecrawl",
  "gemini",
  "grok",
  "kimi",
  "perplexity",
]);
const bundledWebSearchPluginIds = new Set([
  "brave",
  "firecrawl",
  "google",
  "moonshot",
  "perplexity",
  "xai",
]);

function compareEntries(left, right) {
  return (
    left.file.localeCompare(right.file) ||
    left.line - right.line ||
    left.kind.localeCompare(right.kind) ||
    left.specifier.localeCompare(right.specifier) ||
    left.reason.localeCompare(right.reason)
  );
}

function classifyResolvedExtensionReason(kind, resolvedPath) {
  const verb =
    kind === "export"
      ? "re-exports"
      : kind === "dynamic-import"
        ? "dynamically imports"
        : "imports";
  if (/^extensions\/[^/]+\/src\//.test(resolvedPath)) {
    return `${verb} extension implementation from src/plugins`;
  }
  if (/^extensions\/[^/]+\/index\.[^/]+$/.test(resolvedPath)) {
    return `${verb} extension entrypoint from src/plugins`;
  }
  return `${verb} extension-owned file from src/plugins`;
}

function pushEntry(entries, entry) {
  entries.push(entry);
}

function scanImportBoundaryViolations(sourceFile, filePath) {
  const entries = [];
  const relativeFile = normalizeRepoPath(repoRoot, filePath);

  visitModuleSpecifiers(ts, sourceFile, ({ kind, specifier, specifierNode }) => {
    const resolvedPath = resolveRepoSpecifier(repoRoot, specifier, filePath);
    if (!resolvedPath?.startsWith(BUNDLED_PLUGIN_PATH_PREFIX)) {
      return;
    }
    pushEntry(entries, {
      file: relativeFile,
      line: toLine(sourceFile, specifierNode),
      kind,
      specifier,
      resolvedPath,
      reason: classifyResolvedExtensionReason(kind, resolvedPath),
    });
  });
  return entries;
}

function scanWebSearchRegistrySmells(sourceFile, filePath) {
  const relativeFile = normalizeRepoPath(repoRoot, filePath);
  if (relativeFile !== "src/plugins/web-search-providers.ts") {
    return [];
  }

  const entries = [];
  const lines = sourceFile.text.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    const lineNumber = index + 1;

    if (line.includes("web-search-plugin-factory.js")) {
      pushEntry(entries, {
        file: relativeFile,
        line: lineNumber,
        kind: "registry-smell",
        specifier: "../agents/tools/web-search-plugin-factory.js",
        resolvedPath: "src/agents/tools/web-search-plugin-factory.js",
        reason: "imports core-owned web search provider factory into plugin registry",
      });
    }

    const pluginMatch = line.match(/pluginId:\s*"([^"]+)"/);
    if (pluginMatch && bundledWebSearchPluginIds.has(pluginMatch[1])) {
      pushEntry(entries, {
        file: relativeFile,
        line: lineNumber,
        kind: "registry-smell",
        specifier: pluginMatch[1],
        resolvedPath: relativeFile,
        reason: "hardcodes bundled web search plugin ownership in core registry",
      });
    }

    const providerMatch = line.match(/id:\s*"(brave|firecrawl|gemini|grok|kimi|perplexity)"/);
    if (providerMatch && bundledWebSearchProviders.has(providerMatch[1])) {
      pushEntry(entries, {
        file: relativeFile,
        line: lineNumber,
        kind: "registry-smell",
        specifier: providerMatch[1],
        resolvedPath: relativeFile,
        reason: "hardcodes bundled web search provider metadata in core registry",
      });
    }
  }

  return entries;
}

function shouldSkipFile(filePath) {
  const relativeFile = normalizeRepoPath(repoRoot, filePath);
  return (
    relativeFile === "src/plugins/bundled-web-search-registry.ts" ||
    relativeFile.startsWith("src/plugins/contracts/") ||
    /^src\/plugins\/runtime\/runtime-[^/]+-contract\.[cm]?[jt]s$/u.test(relativeFile)
  );
}

export const collectPluginExtensionImportBoundaryInventory = createCachedAsync(async () => {
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
      return [
        ...scanImportBoundaryViolations(sourceFile, filePath),
        ...scanWebSearchRegistrySmells(sourceFile, filePath),
      ];
    },
  });
});

export const readExpectedInventory = createCachedAsync(async () =>
  JSON.parse(await fs.readFile(baselinePath, "utf8")),
);

export function diffInventory(expected, actual) {
  return diffInventoryEntries(expected, actual, compareEntries);
}

const formatInventoryHuman = (inventory) =>
  formatGroupedInventoryHuman(
    {
      rule: "Rule: src/plugins/** must not import bundled plugin files",
      cleanMessage: "No plugin import boundary violations found.",
      inventoryTitle: "Plugin extension import boundary inventory:",
    },
    inventory,
  );

function formatEntry(entry) {
  return `${entry.file}:${entry.line} [${entry.kind}] ${entry.reason} (${entry.specifier} -> ${entry.resolvedPath})`;
}

export async function runPluginExtensionImportBoundaryCheck(argv, io) {
  return await runBaselineInventoryCheck({
    argv: argv ?? process.argv.slice(2),
    io,
    collectActual: collectPluginExtensionImportBoundaryInventory,
    readExpected: readExpectedInventory,
    diffInventory,
    formatInventoryHuman,
    formatEntry,
  });
}

export async function main(argv, io) {
  const exitCode = await runPluginExtensionImportBoundaryCheck(argv, io);
  if (!io && exitCode !== 0) {
    process.exit(exitCode);
  }
  return exitCode;
}

runAsScript(import.meta.url, main);
