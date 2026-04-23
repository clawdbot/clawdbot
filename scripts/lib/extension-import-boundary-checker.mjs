import ts from "typescript";
import { BUNDLED_PLUGIN_PATH_PREFIX } from "./bundled-plugin-paths.mjs";
import {
  collectTypeScriptInventory,
  createCachedAsync,
  formatGroupedInventoryHuman,
  normalizeRepoPath,
  resolveRepoSpecifier,
  visitModuleSpecifiers,
  writeLine,
} from "./guard-inventory-utils.mjs";
import {
  collectTypeScriptFilesFromRoots,
  resolveRepoRoot,
  resolveSourceRoots,
  toLine,
} from "./ts-guard-utils.mjs";

const repoRoot = resolveRepoRoot(import.meta.url);

function compareEntries(left, right) {
  return (
    left.file.localeCompare(right.file) ||
    left.line - right.line ||
    left.kind.localeCompare(right.kind) ||
    left.specifier.localeCompare(right.specifier) ||
    left.reason.localeCompare(right.reason)
  );
}

function classifyResolvedExtensionReason(kind, boundaryLabel) {
  const verb =
    kind === "export"
      ? "re-exports"
      : kind === "dynamic-import"
        ? "dynamically imports"
        : "imports";
  return `${verb} bundled plugin file from ${boundaryLabel} boundary`;
}

function scanImportBoundaryViolations(sourceFile, filePath, boundaryLabel, allowResolvedPath) {
  const entries = [];
  const relativeFile = normalizeRepoPath(repoRoot, filePath);

  visitModuleSpecifiers(ts, sourceFile, ({ kind, specifier, specifierNode }) => {
    const resolvedPath = resolveRepoSpecifier(repoRoot, specifier, filePath);
    if (!resolvedPath?.startsWith(BUNDLED_PLUGIN_PATH_PREFIX)) {
      return;
    }
    if (allowResolvedPath?.(resolvedPath, { kind, specifier, file: relativeFile })) {
      return;
    }
    entries.push({
      file: relativeFile,
      line: toLine(sourceFile, specifierNode),
      kind,
      specifier,
      resolvedPath,
      reason: classifyResolvedExtensionReason(kind, boundaryLabel),
    });
  });

  return entries;
}

export function createExtensionImportBoundaryChecker(params) {
  const scanRoots = resolveSourceRoots(repoRoot, params.roots);

  const collectInventory = createCachedAsync(async () => {
    const files = (await collectTypeScriptFilesFromRoots(scanRoots))
      .filter((filePath) => !params.shouldSkipFile?.(normalizeRepoPath(repoRoot, filePath)))
      .toSorted((left, right) =>
        normalizeRepoPath(repoRoot, left).localeCompare(normalizeRepoPath(repoRoot, right)),
      );
    return await collectTypeScriptInventory({
      ts,
      files,
      compareEntries,
      collectEntries(sourceFile, filePath) {
        return scanImportBoundaryViolations(
          sourceFile,
          filePath,
          params.boundaryLabel,
          params.allowResolvedPath,
        );
      },
      shouldParseSource: params.skipSourcesWithoutBundledPluginPrefix
        ? (source) => source.includes(BUNDLED_PLUGIN_PATH_PREFIX)
        : undefined,
    });
  });

  async function main(argv = process.argv.slice(2), io) {
    const streams = io ?? { stdout: process.stdout, stderr: process.stderr };
    const json = argv.includes("--json");
    const inventory = await collectInventory();

    if (json) {
      writeLine(streams.stdout, JSON.stringify(inventory, null, 2));
    } else {
      writeLine(streams.stdout, formatGroupedInventoryHuman(params, inventory));
      writeLine(
        streams.stdout,
        inventory.length === 0 ? "Boundary is clean." : "Boundary has violations.",
      );
    }

    return inventory.length === 0 ? 0 : 1;
  }

  return { collectInventory, main };
}
