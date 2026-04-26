#!/usr/bin/env node

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BUNDLED_PLUGIN_PATH_PREFIX } from "./lib/bundled-plugin-paths.mjs";
import {
  collectModuleReferencesFromSource,
  normalizeRepoPath,
  resolveRepoSpecifier,
  writeLine,
} from "./lib/guard-inventory-utils.mjs";
import {
  collectTypeScriptFilesFromRoots,
  resolveSourceRoots,
  runAsScript,
} from "./lib/ts-guard-utils.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scanRoots = resolveSourceRoots(repoRoot, ["src/plugin-sdk", "src/plugins/runtime"]);
let architectureSmellsPromise;

function compareEntries(left, right) {
  return (
    left.category.localeCompare(right.category) ||
    left.file.localeCompare(right.file) ||
    left.line - right.line ||
    left.kind.localeCompare(right.kind) ||
    left.specifier.localeCompare(right.specifier) ||
    left.reason.localeCompare(right.reason)
  );
}

function pushEntry(entries, entry) {
  entries.push(entry);
}

function scanPluginSdkExtensionFacadeSmells(source, filePath) {
  const relativeFile = normalizeRepoPath(repoRoot, filePath);
  if (!relativeFile.startsWith("src/plugin-sdk/")) {
    return [];
  }

  const entries = [];

  for (const { kind, line, specifier } of collectModuleReferencesFromSource(source)) {
    if (kind !== "export") {
      continue;
    }
    const resolvedPath = resolveRepoSpecifier(repoRoot, specifier, filePath);
    if (!resolvedPath?.startsWith(BUNDLED_PLUGIN_PATH_PREFIX)) {
      continue;
    }
    pushEntry(entries, {
      category: "plugin-sdk-extension-facade",
      file: relativeFile,
      line,
      kind,
      specifier,
      resolvedPath,
      reason: "plugin-sdk public surface re-exports extension-owned implementation",
    });
  }
  return entries;
}

function scanRuntimeTypeImplementationSmells(source, filePath) {
  const relativeFile = normalizeRepoPath(repoRoot, filePath);
  if (!/^src\/plugins\/runtime\/types(?:-[^/]+)?\.ts$/.test(relativeFile)) {
    return [];
  }

  const entries = [];

  for (const { kind, line, specifier } of collectModuleReferencesFromSource(source)) {
    if (kind !== "dynamic-import") {
      continue;
    }
    const resolvedPath = resolveRepoSpecifier(repoRoot, specifier, filePath);
    if (
      resolvedPath &&
      (/^src\/plugins\/runtime\/runtime-[^/]+\.ts$/.test(resolvedPath) ||
        /^extensions\/[^/]+\/runtime-api\.[^/]+$/.test(resolvedPath))
    ) {
      pushEntry(entries, {
        category: "runtime-type-implementation-edge",
        file: relativeFile,
        line,
        kind: "import-type",
        specifier,
        resolvedPath,
        reason: "runtime type file references implementation shim directly",
      });
    }
  }

  return entries;
}

function scanRuntimeServiceLocatorSmells(source, filePath) {
  const relativeFile = normalizeRepoPath(repoRoot, filePath);
  if (
    !relativeFile.startsWith("src/plugin-sdk/") &&
    !relativeFile.startsWith("src/plugins/runtime/")
  ) {
    return [];
  }

  const entries = [];
  const exportedNames = new Set();
  const runtimeStoreCalls = [];
  const mutableStateNodes = [];

  const lines = source.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    const lineNumber = index + 1;
    const exportedFunction = line.match(/^\s*export\s+function\s+([A-Za-z_$][\w$]*)/);
    if (exportedFunction) {
      exportedNames.add(exportedFunction[1]);
    }
    const exportedVariable = line.match(/^\s*export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/);
    if (exportedVariable) {
      exportedNames.add(exportedVariable[1]);
    }
    for (const mutableMatch of line.matchAll(/^\s*let\s+([A-Za-z_$][\w$]*)/g)) {
      mutableStateNodes.push({ line: lineNumber, text: mutableMatch[1] });
    }
    if (line.includes("createPluginRuntimeStore")) {
      runtimeStoreCalls.push({ line: lineNumber });
    }
  }

  const getterNames = [...exportedNames].filter((name) => /^get[A-Z]/.test(name));
  const setterNames = [...exportedNames].filter((name) => /^set[A-Z]/.test(name));

  if (runtimeStoreCalls.length > 0 && getterNames.length > 0 && setterNames.length > 0) {
    for (const callNode of runtimeStoreCalls) {
      pushEntry(entries, {
        category: "runtime-service-locator",
        file: relativeFile,
        line: callNode.line,
        kind: "runtime-store",
        specifier: "createPluginRuntimeStore",
        resolvedPath: relativeFile,
        reason: `exports paired runtime accessors (${getterNames.join(", ")} / ${setterNames.join(", ")}) over module-global store state`,
      });
    }
  }

  if (mutableStateNodes.length > 0 && getterNames.length > 0 && setterNames.length > 0) {
    for (const identifier of mutableStateNodes) {
      pushEntry(entries, {
        category: "runtime-service-locator",
        file: relativeFile,
        line: identifier.line,
        kind: "mutable-state",
        specifier: identifier.text,
        resolvedPath: relativeFile,
        reason: `module-global mutable state backs exported runtime accessors (${getterNames.join(", ")} / ${setterNames.join(", ")})`,
      });
    }
  }

  return entries;
}

export async function collectArchitectureSmells() {
  if (!architectureSmellsPromise) {
    architectureSmellsPromise = (async () => {
      const files = (await collectTypeScriptFilesFromRoots(scanRoots)).toSorted((left, right) =>
        normalizeRepoPath(repoRoot, left).localeCompare(normalizeRepoPath(repoRoot, right)),
      );
      const entriesByFile = await Promise.all(
        files.map(async (filePath) => {
          const source = await fs.readFile(filePath, "utf8");
          const entries = scanPluginSdkExtensionFacadeSmells(source, filePath);
          entries.push(...scanRuntimeTypeImplementationSmells(source, filePath));
          entries.push(...scanRuntimeServiceLocatorSmells(source, filePath));
          return entries;
        }),
      );
      return entriesByFile.flat().toSorted(compareEntries);
    })();
    try {
      return await architectureSmellsPromise;
    } catch (error) {
      architectureSmellsPromise = undefined;
      throw error;
    }
  }
  return await architectureSmellsPromise;
}

function formatInventoryHuman(inventory) {
  if (inventory.length === 0) {
    return "No architecture smells found for the configured checks.";
  }

  const lines = ["Architecture smell inventory:"];
  let activeCategory = "";
  let activeFile = "";
  for (const entry of inventory) {
    if (entry.category !== activeCategory) {
      activeCategory = entry.category;
      activeFile = "";
      lines.push(entry.category);
    }
    if (entry.file !== activeFile) {
      activeFile = entry.file;
      lines.push(`  ${activeFile}`);
    }
    lines.push(`    - line ${entry.line} [${entry.kind}] ${entry.reason}`);
    lines.push(`      specifier: ${entry.specifier}`);
    lines.push(`      resolved: ${entry.resolvedPath}`);
  }
  return lines.join("\n");
}

export async function runArchitectureSmellsCheck(argv = process.argv.slice(2), io) {
  const streams = io ?? { stdout: process.stdout, stderr: process.stderr };
  const json = argv.includes("--json");
  const inventory = await collectArchitectureSmells();

  if (json) {
    writeLine(streams.stdout, JSON.stringify(inventory, null, 2));
    return 0;
  }

  writeLine(streams.stdout, formatInventoryHuman(inventory));
  writeLine(streams.stdout, `${inventory.length} smell${inventory.length === 1 ? "" : "s"} found.`);
  return 0;
}

export async function main(argv = process.argv.slice(2), io) {
  return await runArchitectureSmellsCheck(argv, io);
}

runAsScript(import.meta.url, main);
