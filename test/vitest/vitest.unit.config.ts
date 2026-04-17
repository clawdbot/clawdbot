import { defineProject } from "vitest/config";
import { loadPatternListFromEnv, narrowIncludePatternsForCli } from "./vitest.pattern-file.ts";
import { resolveVitestIsolation } from "./vitest.scoped-config.ts";
import {
  nonIsolatedRunnerPath,
  resolveRepoRootPath,
  sharedVitestConfig,
} from "./vitest.shared.config.ts";
import { getUnitFastTestFiles } from "./vitest.unit-fast-paths.mjs";
import {
  isBundledPluginDependentUnitTestFile,
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

export function createUnitVitestConfigWithOptions(
  env: Record<string, string | undefined> = process.env,
  options: {
    includePatterns?: string[];
    extraExcludePatterns?: string[];
    name?: string;
    argv?: string[];
  } = {},
) {
  const isolate = resolveVitestIsolation(env);
  const unitFastTestFiles = getUnitFastTestFiles();
  const defaultIncludePatterns = options.includePatterns ?? unitTestIncludePatterns;
  const cliIncludePatterns = narrowIncludePatternsForCli(defaultIncludePatterns, options.argv);
  const protectedIncludeFiles = new Set(
    defaultIncludePatterns.filter((pattern) => isBundledPluginDependentUnitTestFile(pattern)),
  );
  const baseExcludePatterns = unitTestAdditionalExcludePatterns.filter((pattern) => {
    if (protectedIncludeFiles.size === 0) {
      return true;
    }
    return ![...protectedIncludeFiles].some((file) => pattern === file || pattern.endsWith("/**"));
  });
  return defineProject({
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
      include: loadIncludePatternsFromEnv(env) ?? cliIncludePatterns ?? defaultIncludePatterns,
      exclude: [
        ...new Set([
          ...exclude,
          ...baseExcludePatterns,
          ...unitFastTestFiles,
          ...(options.extraExcludePatterns ?? []),
          ...loadExtraExcludePatternsFromEnv(env),
        ]),
      ],
      ...(cliIncludePatterns !== null ? { passWithNoTests: true } : {}),
    },
  });
}

export function createUnitVitestConfig(env: Record<string, string | undefined> = process.env) {
  return createUnitVitestConfigWithOptions(env);
}

export default createUnitVitestConfigWithOptions();
