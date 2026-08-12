#!/usr/bin/env node

import { promises as fs } from "node:fs";
import path from "node:path";
// Inventories extension imports to enforce plugin SDK boundary rules.
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  BUNDLED_PLUGIN_PATH_PREFIX,
  BUNDLED_PLUGIN_ROOT_DIR,
} from "./lib/bundled-plugin-paths.mjs";
import { createExtensionImportBoundaryChecker } from "./lib/extension-import-boundary-checker.mts";
import { classifyBundledExtensionSourcePath } from "./lib/extension-source-classifier.mts";
import {
  formatGroupedInventoryHuman,
  resolveRepoSpecifier,
  writeLine,
} from "./lib/guard-inventory-utils.mjs";
import { resolveRepoRoot } from "./lib/repo-root.mjs";
import { listGeneratedExtensionAssetSources } from "./lib/static-extension-assets.mts";
import { runAsScript } from "./lib/ts-guard-utils.mts";

const DEFAULT_REPO_ROOT = resolveRepoRoot(import.meta.url);
type BoundaryMode =
  | "src-outside-plugin-sdk"
  | "plugin-sdk-internal"
  | "relative-outside-package"
  | "normalization-core-bypass";
type ModuleReference = { kind: string; line: number; specifier: string };
type BoundaryEntry = ModuleReference & { file: string; resolvedPath: string; reason: string };
type CollectedBoundaryEntry = { mode: BoundaryMode; entry: BoundaryEntry };
type BoundaryInventoryByMode = Partial<Record<BoundaryMode, BoundaryEntry[]>>;
type BoundaryCheckIo = {
  stdout: { write(chunk: string): unknown };
  stderr: { write(chunk: string): unknown };
};

const MODES = new Set<BoundaryMode>([
  "src-outside-plugin-sdk",
  "plugin-sdk-internal",
  "relative-outside-package",
  "normalization-core-bypass",
]);

const ruleTextByMode: Record<BoundaryMode, string> = {
  "src-outside-plugin-sdk":
    "Rule: production bundled plugins must not import src/** outside src/plugin-sdk/**",
  "plugin-sdk-internal":
    "Rule: production bundled plugins must not import src/plugin-sdk-internal/**",
  "relative-outside-package":
    "Rule: production bundled plugins must not use relative imports that escape their own package root",
  "normalization-core-bypass":
    "Rule: production bundled plugins must not import normalization-core directly; use the matching openclaw/plugin-sdk coercion runtime",
};

type BaselineBoundaryMode = "plugin-sdk-internal" | "src-outside-plugin-sdk";
const NORMALIZATION_CORE_PACKAGE = "@openclaw/normalization-core";
const NORMALIZATION_CORE_ROOT = "packages/normalization-core";
const DIRECT_COERCION_OWNER_PATHS = new Set(["src/infra/errors", "src/utils/boolean"]);

function baselinePathForMode(repoRoot: string, mode: BaselineBoundaryMode): string {
  const fileName =
    mode === "src-outside-plugin-sdk"
      ? "extension-src-outside-plugin-sdk-inventory.json"
      : "extension-plugin-sdk-internal-inventory.json";
  return path.join(repoRoot, "test", "fixtures", fileName);
}

function stripModuleExtension(filePath: string): string {
  return filePath.replace(/\.(?:[cm]?[jt]s|tsx|jsx)$/u, "");
}

function resolveBoundarySpecifier(repoRoot: string, specifier: string, importerFile: string) {
  if (specifier === NORMALIZATION_CORE_PACKAGE) {
    return `${NORMALIZATION_CORE_ROOT}/src/index.ts`;
  }
  if (specifier.startsWith(`${NORMALIZATION_CORE_PACKAGE}/`)) {
    const subpath = specifier.slice(NORMALIZATION_CORE_PACKAGE.length + 1);
    return `${NORMALIZATION_CORE_ROOT}/src/${stripModuleExtension(subpath)}.ts`;
  }
  return resolveRepoSpecifier(repoRoot, specifier, importerFile);
}

function isNormalizationCoreBypass(specifier: string, resolvedPath: string | null): boolean {
  if (
    specifier === NORMALIZATION_CORE_PACKAGE ||
    specifier.startsWith(`${NORMALIZATION_CORE_PACKAGE}/`)
  ) {
    return true;
  }
  if (!resolvedPath) {
    return false;
  }
  const ownerPath = stripModuleExtension(resolvedPath);
  return (
    ownerPath === NORMALIZATION_CORE_ROOT ||
    ownerPath.startsWith(`${NORMALIZATION_CORE_ROOT}/`) ||
    DIRECT_COERCION_OWNER_PATHS.has(ownerPath)
  );
}

function recommendedCoercionFacade(resolvedPath: string): string | undefined {
  const ownerPath = stripModuleExtension(resolvedPath);
  if (
    ownerPath.endsWith("/string-coerce") ||
    ownerPath.endsWith("/string-normalization") ||
    ownerPath.endsWith("/record-coerce") ||
    ownerPath.endsWith("/boolean-coercion") ||
    ownerPath === "src/utils/boolean"
  ) {
    return "openclaw/plugin-sdk/string-coerce-runtime";
  }
  if (ownerPath.endsWith("/number-coercion")) {
    return "openclaw/plugin-sdk/number-runtime";
  }
  if (ownerPath.endsWith("/error-coercion") || ownerPath === "src/infra/errors") {
    return "openclaw/plugin-sdk/error-runtime";
  }
  return undefined;
}

function classifyReason(mode: BoundaryMode, kind: string, resolved: string, specifier: string) {
  const verb =
    kind === "export"
      ? "re-exports"
      : kind === "dynamic-import"
        ? "dynamically imports"
        : "imports";
  if (mode === "normalization-core-bypass") {
    const facade = recommendedCoercionFacade(resolved);
    return facade
      ? `${verb} ${specifier} directly; plugin production code must use ${facade}`
      : `${verb} ${specifier} directly; plugin production code must use the matching public openclaw/plugin-sdk facade, adding a narrow public SDK seam if needed`;
  }
  if (mode === "relative-outside-package") {
    if (resolved.startsWith("src/plugin-sdk/")) {
      return `${verb} plugin-sdk via relative path; use openclaw/plugin-sdk/<subpath>`;
    }
    if (resolved.startsWith("src/")) {
      return `${verb} core src path via relative path outside the extension package`;
    }
    if (resolved.startsWith(BUNDLED_PLUGIN_PATH_PREFIX)) {
      return `${verb} another bundled plugin via relative path outside the extension package`;
    }
    return `${verb} relative path ${specifier} outside the extension package`;
  }
  if (mode === "plugin-sdk-internal") {
    return `${verb} src/plugin-sdk-internal from an extension`;
  }
  if (resolved.startsWith("src/plugin-sdk/")) {
    return `${verb} allowed plugin-sdk path`;
  }
  return `${verb} core src path outside plugin-sdk from an extension`;
}

function compareEntries(left: BoundaryEntry, right: BoundaryEntry): number {
  return (
    left.file.localeCompare(right.file) ||
    left.line - right.line ||
    left.kind.localeCompare(right.kind) ||
    left.specifier.localeCompare(right.specifier) ||
    left.resolvedPath.localeCompare(right.resolvedPath) ||
    left.reason.localeCompare(right.reason)
  );
}

function isBoundaryEntry(value: unknown): value is BoundaryEntry {
  return (
    isRecord(value) &&
    typeof value.file === "string" &&
    typeof value.line === "number" &&
    typeof value.kind === "string" &&
    typeof value.specifier === "string" &&
    typeof value.resolvedPath === "string" &&
    typeof value.reason === "string"
  );
}

function isBoundaryEntryArray(value: unknown): value is BoundaryEntry[] {
  return Array.isArray(value) && value.every(isBoundaryEntry);
}

async function readExpectedInventoryAtRoot(
  repoRoot: string,
  mode: BaselineBoundaryMode,
): Promise<BoundaryEntry[]> {
  const baselinePath = baselinePathForMode(repoRoot, mode);
  try {
    const inventory: unknown = JSON.parse(await fs.readFile(baselinePath, "utf8"));
    if (!isBoundaryEntryArray(inventory)) {
      throw new Error(`Invalid boundary inventory: ${baselinePath}`);
    }
    return inventory;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

/**
 * Diffs expected and actual boundary inventory entries.
 */
export function diffInventory(expected: BoundaryEntry[], actual: BoundaryEntry[]) {
  const expectedKeys = new Set(expected.map((entry) => JSON.stringify(entry)));
  const actualKeys = new Set(actual.map((entry) => JSON.stringify(entry)));
  return {
    missing: expected
      .filter((entry) => !actualKeys.has(JSON.stringify(entry)))
      .toSorted(compareEntries),
    unexpected: actual
      .filter((entry) => !expectedKeys.has(JSON.stringify(entry)))
      .toSorted(compareEntries),
  };
}

const formatInventoryHuman = (mode: BoundaryMode, inventory: BoundaryEntry[]): string =>
  formatGroupedInventoryHuman(
    {
      rule: ruleTextByMode[mode],
      cleanMessage: "No extension plugin-sdk boundary violations found.",
      inventoryTitle: "Extension boundary inventory:",
    },
    inventory,
  );

/** Creates the extension boundary guard for the repository or an isolated fixture root. */
export function createExtensionPluginSdkBoundaryChecker(options: { repoRoot?: string } = {}) {
  const repoRoot = path.resolve(options.repoRoot ?? DEFAULT_REPO_ROOT);
  // Generated bundles are validated at their build owner; they are not bounded authored source.
  const generatedExtensionAssetSources = new Set(
    listGeneratedExtensionAssetSources({ rootDir: repoRoot }),
  );
  const collectBoundaryEntries: NonNullable<
    Parameters<
      typeof createExtensionImportBoundaryChecker<CollectedBoundaryEntry>
    >[0]["collectEntries"]
  > = ({ filePath, relativeFile, references }) => {
    const extensionRoot = relativeFile.split("/").slice(0, 2).join("/");
    const entries: CollectedBoundaryEntry[] = [];
    for (const { kind, line, specifier } of references) {
      const resolvedPath = resolveBoundarySpecifier(repoRoot, specifier, filePath);
      if (!resolvedPath) {
        continue;
      }
      const modes: BoundaryMode[] = [];
      if (
        specifier.startsWith(".") &&
        resolvedPath !== extensionRoot &&
        !resolvedPath.startsWith(extensionRoot + "/")
      ) {
        modes.push("relative-outside-package");
      }
      if (resolvedPath.startsWith("src/") && !resolvedPath.startsWith("src/plugin-sdk/")) {
        modes.push("src-outside-plugin-sdk");
      }
      if (resolvedPath.startsWith("src/plugin-sdk-internal/")) {
        modes.push("plugin-sdk-internal");
      }
      if (isNormalizationCoreBypass(specifier, resolvedPath)) {
        modes.push("normalization-core-bypass");
      }
      for (const mode of modes) {
        entries.push({
          mode,
          entry: {
            file: relativeFile,
            line,
            kind,
            specifier,
            resolvedPath,
            reason: classifyReason(mode, kind, resolvedPath, specifier),
          },
        });
      }
    }
    return entries;
  };
  const extensionBoundaryChecker = createExtensionImportBoundaryChecker<CollectedBoundaryEntry>({
    repoRoot,
    roots: [BUNDLED_PLUGIN_ROOT_DIR],
    sourceOptions: {
      fileExtensions: [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"],
      includeTests: true,
      skipDirectories: ["dist"],
    },
    shouldSkipFile(relativeFile) {
      return (
        generatedExtensionAssetSources.has(relativeFile) ||
        path.basename(relativeFile).includes("__rootdir_boundary_canary__") ||
        classifyBundledExtensionSourcePath(relativeFile).isTestLike
      );
    },
    acceptSpecifier(specifier, { relativeFile, resolvedPath }) {
      if (
        specifier === NORMALIZATION_CORE_PACKAGE ||
        specifier.startsWith(`${NORMALIZATION_CORE_PACKAGE}/`)
      ) {
        return true;
      }
      if (!resolvedPath) {
        return false;
      }
      const extensionRoot = relativeFile.split("/").slice(0, 2).join("/");
      return (
        resolvedPath.startsWith("src/") ||
        resolvedPath.startsWith(`${NORMALIZATION_CORE_ROOT}/`) ||
        (specifier.startsWith(".") &&
          resolvedPath !== extensionRoot &&
          !resolvedPath.startsWith(extensionRoot + "/"))
      );
    },
    collectEntries: collectBoundaryEntries,
    compareEntries: (left, right) => compareEntries(left.entry, right.entry),
  });
  let allInventoryByModePromise: Promise<BoundaryInventoryByMode> | undefined;

  async function collectInventory(mode: BoundaryMode) {
    if (!MODES.has(mode)) {
      throw new Error("Unknown mode: " + mode);
    }
    allInventoryByModePromise ??= extensionBoundaryChecker
      .collectInventory()
      .then((entries) =>
        Object.fromEntries(
          [...MODES].map((inventoryMode) => [
            inventoryMode,
            entries
              .filter(({ mode: entryMode }) => entryMode === inventoryMode)
              .map(({ entry }) => entry),
          ]),
        ),
      );
    return (await allInventoryByModePromise)[mode] ?? [];
  }

  async function run(
    argv: string[] = process.argv.slice(2),
    streams: BoundaryCheckIo = { stdout: process.stdout, stderr: process.stderr },
  ): Promise<0 | 1> {
    const json = argv.includes("--json");
    const modeArg = argv.find((arg) => arg.startsWith("--mode="));
    const modeValue = modeArg?.slice("--mode=".length) ?? "src-outside-plugin-sdk";
    const mode = [...MODES].find((candidate) => candidate === modeValue);
    if (!mode) {
      throw new Error(`Unknown mode: ${modeValue}`);
    }

    const actual = await collectInventory(mode);
    const strictMode = mode === "normalization-core-bypass" || mode === "relative-outside-package";
    if (json) {
      writeLine(streams.stdout, JSON.stringify(actual, null, 2));
      return strictMode && actual.length > 0 ? 1 : 0;
    }

    writeLine(streams.stdout, formatInventoryHuman(mode, actual));
    if (strictMode) {
      if (actual.length === 0) {
        return 0;
      }
      writeLine(
        streams.stderr,
        `${ruleTextByMode[mode]} violations found (${actual.length}); this strict mode has no baseline.`,
      );
      return 1;
    }

    const expected = await readExpectedInventoryAtRoot(repoRoot, mode);
    const diff = diffInventory(expected, actual);
    if (diff.missing.length === 0 && diff.unexpected.length === 0) {
      writeLine(streams.stdout, `Baseline matches (${actual.length} entries).`);
      return 0;
    }
    if (diff.missing.length > 0) {
      writeLine(streams.stderr, `Missing baseline entries (${diff.missing.length}):`);
      for (const entry of diff.missing) {
        writeLine(streams.stderr, `  - ${entry.file}:${entry.line} ${entry.reason}`);
      }
    }
    if (diff.unexpected.length > 0) {
      writeLine(streams.stderr, `Unexpected inventory entries (${diff.unexpected.length}):`);
      for (const entry of diff.unexpected) {
        writeLine(streams.stderr, `  - ${entry.file}:${entry.line} ${entry.reason}`);
      }
    }
    return 1;
  }

  return { collectInventory, main: run };
}

const defaultBoundaryChecker = createExtensionPluginSdkBoundaryChecker();

/** Reads the checked-in expected boundary inventory from the real repository. */
export async function readExpectedInventory(mode: BaselineBoundaryMode): Promise<BoundaryEntry[]> {
  return await readExpectedInventoryAtRoot(DEFAULT_REPO_ROOT, mode);
}

/**
 * Entrypoint wrapper for the extension plugin SDK boundary check.
 */
export async function main(argv?: string[], io?: BoundaryCheckIo): Promise<0 | 1> {
  const exitCode = await defaultBoundaryChecker.main(argv, io);
  if (!io) {
    process.exitCode = exitCode;
  }
  return exitCode;
}

runAsScript(import.meta.url, main);
