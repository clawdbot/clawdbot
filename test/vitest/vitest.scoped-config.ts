import path from "node:path";
import { defineConfig } from "vitest/config";
import { loadPatternListFromEnv, narrowIncludePatternsForCli } from "./vitest.pattern-file.ts";
import {
  nonIsolatedRunnerPath,
  repoRoot,
  resolveRepoRootPath,
  sharedVitestConfig,
} from "./vitest.shared.config.ts";
import { unitFastTestFiles } from "./vitest.unit-fast-paths.mjs";

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

export function resolveVitestIsolation(
  _env: Record<string, string | undefined> = process.env,
): boolean {
  return false;
}

const SCOPED_PROJECT_GROUP_ORDER_BY_NAME = new Map(
  [
    "acp",
    "agents",
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
    "extension-acpx",
    "extension-bluebubbles",
    "extension-channels",
    "extension-diffs",
    "extension-feishu",
    "extension-irc",
    "extension-mattermost",
    "extension-matrix",
    "extension-memory",
    "extension-messaging",
    "extension-msteams",
    "extension-providers",
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
    "tooling",
    "tui",
    "ui",
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
  const cliInclude = narrowIncludePatternsForCli(include, options?.argv);
  const exclude = relativizeScopedPatterns(
    [...(baseTest.exclude ?? []), ...unitFastTestFiles, ...(options?.exclude ?? [])],
    scopedDir,
  );
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
      ...(options?.passWithNoTests !== undefined || cliInclude !== null
        ? { passWithNoTests: options?.passWithNoTests ?? true }
        : {}),
    },
  });
}
