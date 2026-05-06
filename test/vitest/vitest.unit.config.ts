import fs from "node:fs";
import path from "node:path";
import { defineConfig } from "vitest/config";
import { loadPatternListFromEnv, narrowIncludePatternsForCli } from "./vitest.pattern-file.ts";
import { resolveVitestIsolation } from "./vitest.scoped-config.ts";
import {
  nonIsolatedRunnerPath,
  repoRoot,
  resolveRepoRootPath,
  sharedVitestConfig,
} from "./vitest.shared.config.ts";
import { getUnitFastTestFiles } from "./vitest.unit-fast-paths.mjs";
import {
  isBundledPluginDependentUnitTestFile,
  isUnitConfigTestFile,
  unitTestAdditionalExcludePatterns,
  unitTestIncludePatterns,
} from "./vitest.unit-paths.mjs";

const sharedTest = sharedVitestConfig.test ?? {};
const exclude = sharedTest.exclude ?? [];

export function loadIncludePatternsFromEnv(
  env: Record<string, string | undefined> = process.env,
): string[] | null {
  return loadPatternListFromEnv("OPENCLAW_VITEST_INCLUDE_FILE", env);
}

export function loadExtraExcludePatternsFromEnv(
  env: Record<string, string | undefined> = process.env,
): string[] {
  return loadPatternListFromEnv("OPENCLAW_VITEST_EXTRA_EXCLUDE_FILE", env) ?? [];
}

const defaultUnitCoverageRoots = ["src", "packages", "test"] as const;

function toRepoPath(filePath: string): string {
  return path.relative(repoRoot, filePath).split(path.sep).join("/");
}

function collectTestFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) {
    return [];
  }
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "coverage") {
      continue;
    }
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectTestFiles(entryPath));
    } else if (entry.isFile() && entry.name.endsWith(".test.ts")) {
      files.push(toRepoPath(entryPath));
    }
  }
  return files;
}

function resolveSiblingSourceFile(testFile: string): string | null {
  if (!testFile.endsWith(".test.ts")) {
    return null;
  }
  const sourceFile = testFile.replace(/\.test\.ts$/u, ".ts");
  return fs.existsSync(resolveRepoRootPath(sourceFile)) ? sourceFile : null;
}

export function resolveDefaultUnitCoverageIncludePatterns(
  unitFastTestFiles = getUnitFastTestFiles(),
): string[] {
  const fastTestFiles = new Set(unitFastTestFiles);
  const sourceFiles = new Set<string>();
  for (const root of defaultUnitCoverageRoots) {
    for (const testFile of collectTestFiles(resolveRepoRootPath(root))) {
      if (!isUnitConfigTestFile(testFile) || fastTestFiles.has(testFile)) {
        continue;
      }
      const sourceFile = resolveSiblingSourceFile(testFile);
      if (sourceFile !== null) {
        sourceFiles.add(sourceFile);
      }
    }
  }
  return [...sourceFiles].toSorted((left, right) => left.localeCompare(right));
}

export function createUnitVitestConfigWithOptions(
  env: Record<string, string | undefined> = process.env,
  options: {
    includePatterns?: string[];
    extraExcludePatterns?: string[];
    name?: string;
    argv?: string[];
    passWithNoTests?: boolean;
  } = {},
) {
  const isolate = resolveVitestIsolation(env);
  const unitFastTestFiles = getUnitFastTestFiles();
  const envIncludePatterns = loadIncludePatternsFromEnv(env);
  const defaultIncludePatterns = options.includePatterns ?? unitTestIncludePatterns;
  const cliIncludePatterns = narrowIncludePatternsForCli(defaultIncludePatterns, options.argv);
  const coverageIncludePatterns =
    options.includePatterns === undefined &&
    envIncludePatterns === null &&
    cliIncludePatterns === null
      ? resolveDefaultUnitCoverageIncludePatterns(unitFastTestFiles)
      : null;
  const protectedIncludeFiles = new Set(
    defaultIncludePatterns.filter((pattern) => isBundledPluginDependentUnitTestFile(pattern)),
  );
  const baseExcludePatterns = unitTestAdditionalExcludePatterns.filter((pattern) => {
    if (protectedIncludeFiles.size === 0) {
      return true;
    }
    return ![...protectedIncludeFiles].some((file) => pattern === file || pattern.endsWith("/**"));
  });
  const extraExcludePatterns = options.extraExcludePatterns ?? [];
  return defineConfig({
    ...sharedVitestConfig,
    test: {
      ...sharedTest,
      name: options.name ?? "unit",
      isolate,
      ...(isolate ? { runner: undefined } : { runner: nonIsolatedRunnerPath }),
      setupFiles: [
        ...new Set(
          [...(sharedTest.setupFiles ?? []), "test/setup-openclaw-runtime.ts"].map(
            resolveRepoRootPath,
          ),
        ),
      ],
      include: envIncludePatterns ?? cliIncludePatterns ?? defaultIncludePatterns,
      exclude: [
        ...new Set([
          ...exclude,
          ...baseExcludePatterns,
          ...unitFastTestFiles,
          ...extraExcludePatterns,
          ...loadExtraExcludePatternsFromEnv(env),
        ]),
      ],
      coverage: {
        ...sharedTest.coverage,
        ...(coverageIncludePatterns !== null && coverageIncludePatterns.length > 0
          ? { include: coverageIncludePatterns }
          : {}),
        exclude: [
          ...new Set([
            ...(sharedTest.coverage?.exclude ?? []),
            ...baseExcludePatterns,
            ...extraExcludePatterns,
          ]),
        ],
      },
      ...(options.passWithNoTests || cliIncludePatterns !== null ? { passWithNoTests: true } : {}),
    },
  });
}

export function createUnitVitestConfig(env: Record<string, string | undefined> = process.env) {
  return createUnitVitestConfigWithOptions(env);
}

export default createUnitVitestConfigWithOptions();
