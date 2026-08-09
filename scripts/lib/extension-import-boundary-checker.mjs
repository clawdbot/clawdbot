// Creates reusable import-boundary guards for bundled extension source trees.
import { promises as fs } from "node:fs";
import pMap from "p-map";
import { BUNDLED_PLUGIN_PATH_PREFIX } from "./bundled-plugin-paths.mjs";
import {
  collectModuleReferencesFromSource,
  createCachedAsync,
  formatGroupedInventoryHuman,
  normalizeRepoPath,
  resolveRepoSpecifier,
  writeLine,
} from "./guard-inventory-utils.mjs";
import { resolveRepoRoot } from "./repo-root.mjs";
import { collectTypeScriptFilesFromRoots, resolveSourceRoots } from "./ts-guard-utils.mjs";

const repoRoot = resolveRepoRoot(import.meta.url);
const DEFAULT_BOUNDARY_SOURCE_MAX_BYTES = 2 * 1024 * 1024;
// Escaped plugin paths must reach the scanner without lexing every unrelated escaped source.
const ESCAPED_BUNDLED_PLUGIN_PATH_PREFIX_RE = new RegExp(
  Array.from(BUNDLED_PLUGIN_PATH_PREFIX, (character) => {
    const hex = character.charCodeAt(0).toString(16).padStart(2, "0");
    return (
      "(?:" +
      character +
      "|\\\\(?:x" +
      hex +
      "|u00" +
      hex +
      "|u\\{0*" +
      hex +
      "\\}|" +
      character +
      "))(?:\\\\(?:\\r\\n|[\\r\\n\\u2028\\u2029]))*"
    );
  }).join(""),
  "iu",
);

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

function scanImportBoundaryViolations(references, filePath, boundaryLabel, allowResolvedPath) {
  const entries = [];
  const relativeFile = normalizeRepoPath(repoRoot, filePath);

  for (const { kind, line, specifier } of references) {
    const resolvedPath = resolveRepoSpecifier(repoRoot, specifier, filePath);
    if (!resolvedPath?.startsWith(BUNDLED_PLUGIN_PATH_PREFIX)) {
      continue;
    }
    if (allowResolvedPath?.(resolvedPath, { kind, specifier, file: relativeFile })) {
      continue;
    }
    entries.push({
      file: relativeFile,
      line,
      kind,
      specifier,
      resolvedPath,
      reason: classifyResolvedExtensionReason(kind, boundaryLabel),
    });
  }

  return entries;
}

function normalizeMaxSourceBytes(value) {
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_BOUNDARY_SOURCE_MAX_BYTES;
}

function assertSourceFileWithinLimit(filePath, bytes, maxBytes) {
  if (bytes <= maxBytes) {
    return;
  }
  throw new Error(
    `extension import boundary source file exceeds ${maxBytes} byte limit: ${normalizeRepoPath(
      repoRoot,
      filePath,
    )} (${bytes} bytes)`,
  );
}

async function readBoundedSourceFile(filePath, maxBytes) {
  const stat = await fs.stat(filePath);
  assertSourceFileWithinLimit(filePath, stat.size, maxBytes);
  const source = await fs.readFile(filePath, "utf8");
  assertSourceFileWithinLimit(filePath, Buffer.byteLength(source, "utf8"), maxBytes);
  return source;
}

/** Create a boundary checker with cached inventory collection and a CLI-style main function. */
export function createExtensionImportBoundaryChecker(params) {
  const scanRoots = resolveSourceRoots(repoRoot, params.roots);
  const maxSourceBytes = normalizeMaxSourceBytes(params.maxSourceBytes);

  const collectInventory = createCachedAsync(async () => {
    const files = (await collectTypeScriptFilesFromRoots(scanRoots, params.sourceOptions))
      .filter((filePath) => !params.shouldSkipFile?.(normalizeRepoPath(repoRoot, filePath)))
      .toSorted((left, right) =>
        normalizeRepoPath(repoRoot, left).localeCompare(normalizeRepoPath(repoRoot, right)),
      );
    const entriesByFile = await pMap(
      files,
      async (filePath) => {
        const source = await readBoundedSourceFile(filePath, maxSourceBytes);
        const relativeFile = normalizeRepoPath(repoRoot, filePath);
        if (
          params.skipSourcesWithoutBundledPluginPrefix &&
          !source.includes(BUNDLED_PLUGIN_PATH_PREFIX) &&
          (!source.includes("\\") || !ESCAPED_BUNDLED_PLUGIN_PATH_PREFIX_RE.test(source))
        ) {
          return [];
        }
        const references = collectModuleReferencesFromSource(source, {
          fileName: filePath,
          acceptSpecifier(specifier) {
            const resolvedPath = resolveRepoSpecifier(repoRoot, specifier, filePath);
            return params.acceptSpecifier
              ? params.acceptSpecifier(specifier, { filePath, relativeFile, resolvedPath })
              : Boolean(resolvedPath?.startsWith(BUNDLED_PLUGIN_PATH_PREFIX));
          },
        });
        return params.collectEntries
          ? params.collectEntries({ source, filePath, relativeFile, references })
          : scanImportBoundaryViolations(
              references,
              filePath,
              params.boundaryLabel,
              params.allowResolvedPath,
            );
      },
      { concurrency: 32, stopOnError: true },
    );
    const inventory = entriesByFile.flat();
    return inventory.toSorted(params.compareEntries ?? compareEntries);
  });

  async function main(argv, io) {
    const args = argv ?? process.argv.slice(2);
    const streams = io ?? { stdout: process.stdout, stderr: process.stderr };
    const json = args.includes("--json");
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
