// Vitest scoped config helper builds test configs for scoped file patterns.
import path from "node:path";
import { defineConfig } from "vitest/config";
import { loadPatternListFromEnv, narrowIncludePatternsForCli } from "./vitest.pattern-file.ts";
import {
  nonIsolatedRunnerPath,
  repoRoot,
  resolveRepoRootPath,
  sharedVitestConfig,
} from "./vitest.shared.config.ts";
import { getUnitFastTestFiles } from "./vitest.unit-fast-paths.mjs";

function normalizePathPattern(value: string): string {
  return value.replaceAll("\\", "/");
}

function relativizeScopedPattern(value: string, dir: string): string {
  const normalizedValue = normalizePathPattern(value);
  const normalizedDir = normalizePathPattern(dir).replace(/\/+$/u, "");
  if (!normalizedDir) {
    return normalizedValue;
  }
  if (normalizedValue === normalizedDir) {
    return ".";
  }
  const prefix = `${normalizedDir}/`;
  return normalizedValue.startsWith(prefix)
    ? normalizedValue.slice(prefix.length)
    : normalizedValue;
}

function relativizeScopedPatterns(values: string[], dir?: string): string[] {
  if (!dir) {
    return values.map(normalizePathPattern);
  }
  return values.map((value) => relativizeScopedPattern(value, dir));
}

function globRoot(pattern: string): string | null {
  const globStart = pattern.search(/[*{[]/u);
  if (globStart < 0) {
    return null;
  }
  const slashBeforeGlob = pattern.lastIndexOf("/", globStart);
  if (slashBeforeGlob < 0) {
    return "";
  }
  return pattern.slice(0, slashBeforeGlob);
}

function directoryPatternCoversInclude(excludePattern: string, includePattern: string): boolean {
  if (!excludePattern.endsWith("/**")) {
    return false;
  }
  const excludeRoot = excludePattern.slice(0, -"/**".length);
  const includeRoot = globRoot(includePattern);
  const candidate = includeRoot ?? includePattern;
  return candidate === excludeRoot || candidate.startsWith(`${excludeRoot}/`);
}

export function includePatternIsFullyExcluded(
  includePattern: string,
  excludePattern: string,
): boolean {
  const include = normalizePathPattern(includePattern);
  const exclude = normalizePathPattern(excludePattern);
  return (
    include === exclude ||
    path.matchesGlob(include, exclude) ||
    directoryPatternCoversInclude(exclude, include)
  );
}

export function shouldPassWithNoTestsForCliIncludes(
  cliIncludePatterns: string[] | null,
  excludePatterns: string[],
): boolean {
  if (cliIncludePatterns === null) {
    return false;
  }
  return cliIncludePatterns.every((includePattern) =>
    excludePatterns.some((excludePattern) =>
      includePatternIsFullyExcluded(includePattern, excludePattern),
    ),
  );
}

export function resolveVitestIsolation(
  _env: Record<string, string | undefined> = process.env,
): boolean {
  return false;
}

const SCOPED_PROJECT_GROUP_ORDER_BY_NAME = new Map(
  [
    "acp",
    "agents",
    "agents-core",
    "agents-embedded-agent",
    "agents-support",
    "agents-tools",
    "auto-reply",
    "auto-reply-core",
    "auto-reply-reply",
    "auto-reply-top-level",
    "boundary",
    "bundled",
    "channels",
    "cli",
    "commands",
    "commands-light",
    "cron",
    "daemon",
    "extension-active-memory",
    "extension-acpx",
    "extension-channels",
    "extension-codex",
    "extension-diffs",
    "extension-discord",
    "extension-feishu",
    "extension-imessage",
    "extension-irc",
    "extension-line",
    "extension-mattermost",
    "extension-matrix",
    "extension-media",
    "extension-memory",
    "extension-messaging",
    "extension-msteams",
    "extension-provider-openai",
    "extension-providers",
    "extension-signal",
    "extension-slack",
    "extension-telegram",
    "extension-voice-call",
    "extension-whatsapp",
    "extension-zalo",
    "extensions",
    "gateway",
    "hooks",
    "infra",
    "logging",
    "media",
    "media-understanding",
    "plugin-sdk",
    "plugin-sdk-light",
    "plugins",
    "process",
    "runtime-config",
    "secrets",
    "shared-core",
    "tasks",
    "tooling-isolated",
    "tooling",
    "tui",
    "ui",
    "ui-e2e",
    "unit-fast",
    "unit-security",
    "unit-src",
    "unit-support",
    "unit-ui",
    "utils",
    "wizard",
  ].map((name, index) => [name, index + 10]),
);

function hashFallbackScopedProjectGroupOrder(key: string): number {
  let hash = 0;
  for (const char of key) {
    hash = (hash * 33 + char.charCodeAt(0)) % 10_000;
  }
  return hash + 1_000;
}

function resolveScopedProjectGroupOrder(
  name?: string,
  dir?: string,
  include?: string[],
): number | undefined {
  const normalizedName = name?.trim();
  if (normalizedName) {
    return (
      SCOPED_PROJECT_GROUP_ORDER_BY_NAME.get(normalizedName) ??
      hashFallbackScopedProjectGroupOrder(normalizedName)
    );
  }
  const normalizedInclude = include?.map(normalizePathPattern).join("|") ?? "";
  const key = [dir?.trim(), normalizedInclude].filter(Boolean).join("|");
  if (!key) {
    return undefined;
  }
  return hashFallbackScopedProjectGroupOrder(key);
}

export function createScopedVitestConfig(
  include: string[],
  options?: {
    deps?: Record<string, unknown>;
    dir?: string;
    env?: Record<string, string | undefined>;
    environment?: string;
    exclude?: string[];
    argv?: string[];
    includeOpenClawRuntimeSetup?: boolean;
    isolate?: boolean;
    name?: string;
    fileParallelism?: boolean;
    pool?: "forks" | "threads";
    passWithNoTests?: boolean;
    excludeUnitFastTests?: boolean;
    setupFiles?: string[];
    useNonIsolatedRunner?: boolean;
  },
) {
  const base = sharedVitestConfig as Record<string, unknown>;
  const baseTest = sharedVitestConfig.test ?? {};
  const scopedDir = options?.dir;
  const resolvedScopedDir = scopedDir ? path.join(repoRoot, scopedDir) : undefined;
  const env = options?.env;
  const includeFromEnv = loadPatternListFromEnv("OPENCLAW_VITEST_INCLUDE_FILE", env);
  const cliInclude = narrowIncludePatternsForCli(include, options?.argv, {
    scopedDir,
  });
  const unitFastExcludePatterns =
    options?.excludeUnitFastTests === false ? [] : getUnitFastTestFiles();
  const exclude = relativizeScopedPatterns(
    [...(baseTest.exclude ?? []), ...unitFastExcludePatterns, ...(options?.exclude ?? [])],
    scopedDir,
  );
  const scopedCliInclude = cliInclude ? relativizeScopedPatterns(cliInclude, scopedDir) : null;
  const isolate = options?.isolate ?? resolveVitestIsolation(options?.env);
  const setupFiles = [
    ...new Set([
      ...(baseTest.setupFiles ?? []),
      ...(options?.setupFiles ?? []),
      ...(options?.includeOpenClawRuntimeSetup === false ? [] : ["test/setup-openclaw-runtime.ts"]),
    ]),
  ].map(resolveRepoRootPath);
  const useNonIsolatedRunner = options?.useNonIsolatedRunner ?? !isolate;
  const runner = useNonIsolatedRunner ? nonIsolatedRunnerPath : undefined;
  const scopedGroupOrder = resolveScopedProjectGroupOrder(options?.name, scopedDir, include);

  return defineConfig({
    ...base,
    test: {
      ...baseTest,
      ...(options?.deps ? { deps: options.deps } : {}),
      ...(options?.name ? { name: options.name } : {}),
      ...(options?.environment ? { environment: options.environment } : {}),
      isolate,
      ...(runner ? { runner } : { runner: undefined }),
      setupFiles,
      ...(resolvedScopedDir ? { dir: resolvedScopedDir } : {}),
      include: relativizeScopedPatterns(includeFromEnv ?? cliInclude ?? include, scopedDir),
      exclude,
      ...(options?.pool ? { pool: options.pool } : {}),
      ...(options?.fileParallelism === undefined
        ? {}
        : { fileParallelism: options.fileParallelism }),
      ...(scopedGroupOrder === undefined
        ? {}
        : {
            sequence: {
              ...baseTest.sequence,
              groupOrder: scopedGroupOrder,
            },
          }),
      ...(options?.passWithNoTests !== undefined
        ? { passWithNoTests: options.passWithNoTests }
        : shouldPassWithNoTestsForCliIncludes(scopedCliInclude, exclude)
          ? { passWithNoTests: true }
          : {}),
    },
  });
}
