// Vitest pattern file helper reads include and exclude patterns from files.
import fs from "node:fs";
import path from "node:path";

const VITEST_OPTION_VALUE_FLAGS = new Set([
  "-c",
  "-r",
  "-t",
  "--browser",
  "--changed",
  "--config",
  "--coverage.all",
  "--coverage.exclude",
  "--coverage.extension",
  "--coverage.include",
  "--coverage.provider",
  "--coverage.reporter",
  "--coverage.reportsDirectory",
  "--dir",
  "--environment",
  "--environmentOptions",
  "--exclude",
  "--hookTimeout",
  "--inspect",
  "--inspectBrk",
  "--maxConcurrency",
  "--maxWorkers",
  "--minWorkers",
  "--mode",
  "--name",
  "--outputFile",
  "--pool",
  "--project",
  "--reporter",
  "--retry",
  "--root",
  "--sequence",
  "--shard",
  "--testNamePattern",
  "--testTimeout",
  "--workspace",
]);

function normalizeCliPattern(value: string): string {
  let normalized = value
    .trim()
    .replace(/^\.\/+/u, "")
    .replace(/\/+$/u, "");
  if (
    /^(?:src|test|extensions|ui|packages|apps)(?:\/|$)/u.test(normalized) &&
    !/[?*[\]{}]/u.test(normalized) &&
    !/\.(?:[cm]?[jt]sx?)$/u.test(normalized)
  ) {
    normalized = `${normalized}/**/*.test.*`;
  }
  return normalized;
}

function normalizeScopedDir(value: string | undefined): string {
  return value?.trim().replaceAll("\\", "/").replace(/\/+$/u, "") ?? "";
}

function hasRepoRootPrefix(value: string): boolean {
  return /^(?:src|test|extensions|ui|packages|apps)(?:\/|$)/u.test(value);
}

function looksLikeDirRelativePath(value: string): boolean {
  return (
    value.includes("/") ||
    value.includes(".test.") ||
    value.includes(".e2e.") ||
    value.includes(".live.")
  );
}

function applyScopedDir(value: string, scopedDir: string): string {
  const normalizedValue = value
    .trim()
    .replace(/^\.\/+/u, "")
    .replaceAll("\\", "/");
  if (
    !scopedDir ||
    hasRepoRootPrefix(normalizedValue) ||
    path.isAbsolute(value) ||
    !looksLikeDirRelativePath(normalizedValue)
  ) {
    return normalizedValue;
  }
  return `${scopedDir}/${normalizedValue}`;
}

function looksLikeCliIncludePattern(value: string): boolean {
  const normalized = normalizeCliPattern(value);
  return (
    normalized.includes(".test.") ||
    normalized.includes(".e2e.") ||
    normalized.includes(".live.") ||
    /^(?:src|test|extensions|ui|packages|apps)(?:\/|$)/u.test(normalized)
  );
}

function literalPrefixForGlobPattern(value: string): string {
  const normalized = value.replaceAll("\\", "/");
  const globIndex = normalized.search(/[?*[\]{}]/u);
  if (globIndex === -1) {
    return normalized;
  }
  const slashIndex = normalized.lastIndexOf("/", globIndex);
  return slashIndex === -1 ? "" : normalized.slice(0, slashIndex + 1);
}

function patternsCouldOverlap(value: string, pattern: string): boolean {
  if (path.matchesGlob(value, pattern) || path.matchesGlob(pattern, value)) {
    return true;
  }

  const valuePrefix = literalPrefixForGlobPattern(value);
  const patternPrefix = literalPrefixForGlobPattern(pattern);
  return (
    patternPrefix === "" ||
    valuePrefix === "" ||
    valuePrefix.startsWith(patternPrefix) ||
    patternPrefix.startsWith(valuePrefix)
  );
}

export function loadPatternListFile(filePath: string, label: string): string[] {
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
  if (!Array.isArray(parsed)) {
    throw new TypeError(`${label} must point to a JSON array: ${filePath}`);
  }
  return parsed.filter((value): value is string => typeof value === "string" && value.length > 0);
}

export function loadPatternListFromEnv(
  envKey: string,
  env: Record<string, string | undefined> = process.env,
): string[] | null {
  const filePath = env[envKey]?.trim();
  if (!filePath) {
    return null;
  }
  return loadPatternListFile(filePath, envKey);
}

export function loadPatternListFromArgv(argv: string[] = process.argv): string[] | null {
  return loadPatternListFromArgvForScope(argv);
}

function loadPatternListFromArgvForScope(
  argv: string[] = process.argv,
  options: { scopedDir?: string } = {},
): string[] | null {
  const values: string[] = [];
  let skipNext = false;
  for (const value of argv.slice(2)) {
    if (skipNext) {
      skipNext = false;
      continue;
    }
    if (value === "run" || value === "watch" || value === "bench") {
      continue;
    }
    if (VITEST_OPTION_VALUE_FLAGS.has(value)) {
      skipNext = true;
      continue;
    }
    if (value.startsWith("-")) {
      continue;
    }
    values.push(value);
  }

  const scopedDir = normalizeScopedDir(options.scopedDir);
  const patterns = values
    .map((value) => applyScopedDir(value, scopedDir))
    .filter(looksLikeCliIncludePattern)
    .map(normalizeCliPattern);

  return patterns.length > 0 ? [...new Set(patterns)] : null;
}

export function narrowIncludePatternsForCli(
  includePatterns: string[],
  argv: string[] = process.argv,
  options: { scopedDir?: string } = {},
): string[] | null {
  const cliPatterns = loadPatternListFromArgvForScope(argv, options);
  if (!cliPatterns) {
    return null;
  }

  const matched = cliPatterns.filter((value) =>
    includePatterns.some((pattern) => patternsCouldOverlap(value, pattern)),
  );

  return [...new Set(matched)];
}
