#!/usr/bin/env node
// Builds OpenClaw packages and plugin SDK artifacts with cache-aware orchestration.

import { spawnSync, type SpawnSyncOptions } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { asRecord } from "@openclaw/normalization-core/record-coerce";
import prettyMilliseconds from "pretty-ms";
import { resolveBuildIdentityEnvironment } from "./lib/build-identity.mts";
import { isDirectRunUrl } from "./lib/direct-run.mjs";
import {
  listPluginSdkDistArtifacts,
  listPluginSdkDeclarationOutputs,
  pluginSdkEntrypoints,
} from "./lib/plugin-sdk-entries.mts";
import {
  TSDOWN_PACKAGE_CONFIG_GROUP,
  TSDOWN_UNIFIED_CONFIG_GROUP,
} from "./lib/tsdown-config-groups.mts";
import {
  TSDOWN_PACKAGE_OUTPUT_ROOTS,
  tsdownPackageOutputRoot,
} from "./lib/tsdown-output-roots.mts";
import { resolvePnpmRunner } from "./pnpm-runner.mts";
import {
  TSDOWN_MAX_OLD_SPACE_MB_ENV,
  resolveTsdownBuildPlan,
  type MemoryLimitParams,
} from "./tsdown-build.mts";

const nodeBin = process.execPath;
type BuildCachePath = {
  path: string;
  excludeDirectories?: string[];
  extensions?: string[];
  recursive?: boolean;
};
export type BuildCacheEntry = string | BuildCachePath;

type BuildCache = {
  env?: string[];
  inputs: BuildCacheEntry[];
  outputs: BuildCacheEntry[];
  requiredOutputs?: string[] | ((env: NodeJS.ProcessEnv) => string[]);
  requiredCacheHitOutputs?: string[];
  restore?: "always";
  runOnHit?: { env?: NodeJS.ProcessEnv; finalize?: "refresh" };
};

type BuildCacheStep = { label: string; env?: NodeJS.ProcessEnv; cache?: BuildCache };

export type BuildAllStep = BuildCacheStep &
  (
    | { kind: "pnpm"; args?: never; pnpmArgs: string[]; windowsNodeOptions?: string }
    | { kind?: "node"; args: string[]; pnpmArgs?: never; windowsNodeOptions?: string }
  );

type BuildAllTiming = { label: string; durationMs: number; status: string };
type BuildAllFs = typeof fs;
type BuildAllStepParams = {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  nodeExecPath?: string;
  npmExecPath?: string;
  comSpec?: string;
};
type BuildAllCacheParams = { rootDir?: string; fs?: BuildAllFs; env?: NodeJS.ProcessEnv };
const BUILD_CACHE_VERSION = 4;
const RUN_NODE_SKIP_DTS_BUILD_ENV = "OPENCLAW_RUN_NODE_SKIP_DTS_BUILD";
const TSDOWN_DECLARATION_EXTENSIONS = [".d.ts", ".d.mts", ".d.cts"];
const TSDOWN_SOURCE_EXTENSIONS = [
  ".cjs",
  ".cts",
  ".js",
  ".json",
  ".json5",
  ".mjs",
  ".mts",
  ".sql",
  ".ts",
  ".tsx",
  ".yaml",
  ".yml",
];
const TSDOWN_AI_OUTPUT_ROOT = tsdownPackageOutputRoot("ai");
const TSDOWN_MAIN_PACKAGE_OUTPUT_ROOTS = TSDOWN_PACKAGE_OUTPUT_ROOTS.filter(
  (root) => root !== TSDOWN_AI_OUTPUT_ROOT,
);
const TSDOWN_DECLARATION_TOOL_INPUTS = [
  "package.json",
  "pnpm-lock.yaml",
  "tsconfig.json",
  "scripts/tsdown-build.mts",
  "scripts/lib/bundled-plugin-build-entries.mjs",
  "scripts/lib/bundled-plugin-paths.mjs",
  "scripts/lib/optional-bundled-clusters.mjs",
  "scripts/lib/plugin-sdk-entries.mts",
  "scripts/lib/plugin-sdk-entrypoints.json",
  "scripts/lib/plugin-sdk-private-local-only-subpaths.json",
  "scripts/lib/plugin-sdk-deprecated-public-subpaths.json",
  "scripts/lib/plugin-sdk-deprecated-barrel-subpaths.json",
  "scripts/lib/root-package-bundled-plugin-excludes.mjs",
  "scripts/lib/tsdown-config-groups.mts",
  "scripts/lib/tsdown-output-roots.mts",
];
const TSDOWN_PACKAGES_CACHE_INPUT = {
  path: "packages",
  extensions: TSDOWN_SOURCE_EXTENSIONS,
  excludeDirectories: ["dist", "node_modules"],
};
const TSDOWN_UNIFIED_CACHE_INPUTS = [
  {
    path: "src",
    extensions: TSDOWN_SOURCE_EXTENSIONS,
    excludeDirectories: ["dist", "node_modules"],
  },
  {
    path: "extensions",
    extensions: TSDOWN_SOURCE_EXTENSIONS,
    excludeDirectories: ["dist", "node_modules"],
  },
  TSDOWN_PACKAGES_CACHE_INPUT,
];
const declarationCacheOutputs = (roots: string[]) =>
  roots.map((root) => ({ path: root, extensions: TSDOWN_DECLARATION_EXTENSIONS }));
const PLUGIN_SDK_ENTRY_DTS_CACHE_ENV = [
  "OPENCLAW_BUILD_PRIVATE_QA",
  "OPENCLAW_PLUGIN_SDK_CANONICAL_DTS",
];
const PLUGIN_SDK_ENTRY_DTS_SHARED_CACHE_INPUTS = [
  "scripts/write-plugin-sdk-entry-dts.ts",
  "scripts/lib/declaration-source-index.mts",
  "scripts/lib/direct-run.mjs",
  "scripts/lib/plugin-sdk-entries.mts",
  "scripts/lib/plugin-sdk-entrypoints.json",
  "scripts/lib/plugin-sdk-private-local-only-subpaths.json",
  "scripts/lib/plugin-sdk-deprecated-public-subpaths.json",
  "scripts/lib/plugin-sdk-deprecated-barrel-subpaths.json",
];
const PLUGIN_SDK_ENTRY_DTS_CACHE_INPUTS = [
  ...PLUGIN_SDK_ENTRY_DTS_SHARED_CACHE_INPUTS,
  { path: "dist/plugin-sdk", extensions: [".d.ts"], recursive: false },
];
const PLUGIN_SDK_SELF_BUILT_ENTRY_DTS_CACHE_INPUTS = [
  "scripts/write-plugin-sdk-entry-dts.ts",
  "package.json",
  "pnpm-lock.yaml",
  "tsconfig.json",
  "tsconfig.plugin-sdk.dts.json",
  "node-version.d.mts",
  // SDK source types also depend on build metadata and private QA helpers.
  ...["src", "packages", "scripts/lib", "test/helpers"].map((sourceRoot) => ({
    path: sourceRoot,
    extensions: TSDOWN_SOURCE_EXTENSIONS,
    excludeDirectories: ["dist", "node_modules"],
  })),
];
const PLUGIN_SDK_ENTRY_DTS_CACHE_OUTPUTS = [
  "dist/plugin-sdk/.boundary-entry-shims.stamp",
  ...pluginSdkEntrypoints.map((entry) => `packages/plugin-sdk/dist/src/plugin-sdk/${entry}.d.ts`),
];
const PLUGIN_SDK_SELF_BUILT_ENTRY_DTS_CACHE_OUTPUTS = [
  { path: "dist/plugin-sdk", extensions: [".d.ts"], recursive: false },
  ...PLUGIN_SDK_ENTRY_DTS_CACHE_OUTPUTS,
];
const tsxScript = (script: string, ...args: string[]) => ["--import", "tsx", script, ...args];
const nodeStep = (label: string, args: string[]): Extract<BuildAllStep, { kind?: "node" }> => ({
  label,
  kind: "node",
  args,
});
const tsxStep = (label: string, script: string, ...args: string[]) =>
  nodeStep(label, tsxScript(script, ...args));
const PNPM_STEP_NODE_FALLBACKS = new Map([
  ["plugins:assets:build", tsxScript("scripts/bundled-plugin-assets.mts", "--phase", "build")],
  ["plugins:assets:copy", tsxScript("scripts/bundled-plugin-assets.mts", "--phase", "copy")],
  ["ui:build", ["scripts/ui.js", "build"]],
]);
export const BUILD_ALL_STEPS: BuildAllStep[] = [
  nodeStep("clean:dist", [
    "-e",
    'require("node:fs").rmSync("dist", { recursive: true, force: true })',
  ]),
  { label: "plugins:assets:build", kind: "pnpm", pnpmArgs: ["plugins:assets:build"] },
  tsxStep("tsdown", "scripts/tsdown-build.mts"),
  {
    ...tsxStep("tsdown-ai", "scripts/tsdown-build.mts", "--config", "tsdown.ai.config.ts"),
    cache: {
      env: ["OPENCLAW_RUN_NODE_SKIP_DTS_BUILD"],
      inputs: [
        ...TSDOWN_DECLARATION_TOOL_INPUTS,
        "tsdown.ai.config.ts",
        TSDOWN_PACKAGES_CACHE_INPUT,
      ],
      outputs: declarationCacheOutputs([TSDOWN_AI_OUTPUT_ROOT]),
      restore: "always",
      runOnHit: {
        env: { OPENCLAW_RUN_NODE_SKIP_DTS_BUILD: "1" },
      },
    },
  },
  {
    ...tsxStep(
      "tsdown-packages",
      "scripts/tsdown-build.mts",
      "--config",
      "tsdown.config.ts",
      "--filter",
      TSDOWN_PACKAGE_CONFIG_GROUP,
    ),
    cache: {
      env: ["OPENCLAW_RUN_NODE_SKIP_DTS_BUILD"],
      inputs: [...TSDOWN_DECLARATION_TOOL_INPUTS, "tsdown.config.ts", TSDOWN_PACKAGES_CACHE_INPUT],
      outputs: declarationCacheOutputs(TSDOWN_MAIN_PACKAGE_OUTPUT_ROOTS),
      restore: "always",
      runOnHit: {
        env: { OPENCLAW_RUN_NODE_SKIP_DTS_BUILD: "1" },
      },
    },
  },
  {
    ...tsxStep(
      "tsdown-unified",
      "scripts/tsdown-build.mts",
      "--config",
      "tsdown.config.ts",
      "--filter",
      TSDOWN_UNIFIED_CONFIG_GROUP,
    ),
    cache: {
      env: ["OPENCLAW_BUILD_PRIVATE_QA", "OPENCLAW_RUN_NODE_SKIP_DTS_BUILD"],
      inputs: [
        ...TSDOWN_DECLARATION_TOOL_INPUTS,
        "tsdown.config.ts",
        ...TSDOWN_UNIFIED_CACHE_INPUTS,
      ],
      outputs: declarationCacheOutputs(["dist"]),
      requiredOutputs: (env) =>
        env.OPENCLAW_BUILD_PRIVATE_QA === "1"
          ? listPluginSdkDeclarationOutputs(pluginSdkEntrypoints)
          : listPluginSdkDeclarationOutputs(),
      // Shared declaration snapshots cannot make a replaced live dist complete.
      // Rebuild the unified unit when its package artifacts are no longer intact.
      requiredCacheHitOutputs: listPluginSdkDistArtifacts(),
      restore: "always",
      runOnHit: {
        env: { OPENCLAW_RUN_NODE_SKIP_DTS_BUILD: "1" },
      },
    },
  },
  tsxStep("external-plugins:local-dist", "scripts/build-external-plugin-local-dist.mts"),
  tsxStep("check-cli-bootstrap-imports", "scripts/check-cli-bootstrap-imports.mts"),
  {
    label: "plugins:assets:copy",
    kind: "pnpm",
    pnpmArgs: ["plugins:assets:copy"],
  },
  nodeStep("runtime-postbuild", ["scripts/runtime-postbuild.mjs"]),
  tsxStep("build-stamp", "scripts/build-stamp.mts"),
  tsxStep("runtime-postbuild-stamp", "scripts/runtime-postbuild-stamp.mts"),
  {
    ...tsxStep("write-plugin-sdk-entry-dts", "scripts/write-plugin-sdk-entry-dts.ts"),
    env: {
      OPENCLAW_PLUGIN_SDK_CANONICAL_DTS: "1",
    },
    cache: {
      env: PLUGIN_SDK_ENTRY_DTS_CACHE_ENV,
      inputs: PLUGIN_SDK_ENTRY_DTS_CACHE_INPUTS,
      outputs: PLUGIN_SDK_ENTRY_DTS_CACHE_OUTPUTS,
      restore: "always",
    },
  },
  tsxStep("check-plugin-sdk-exports", "scripts/check-plugin-sdk-exports.mts"),
  {
    label: "ui:build",
    kind: "pnpm",
    pnpmArgs: ["ui:build"],
    // No build-all cache: ui/vite.config.ts derives the Control UI build ID
    // from package.json, git HEAD, and OPENCLAW_CONTROL_UI_BUILD_ID env, so a
    // file-input signature cannot exactly invalidate generated assets and a
    // warm hit could restore stale service-worker/app cache metadata.
    cache: undefined,
  },
  tsxStep("write-build-info", "scripts/write-build-info.ts"),
  {
    ...tsxStep("write-cli-startup-metadata", "scripts/write-cli-startup-metadata.ts"),
    cache: {
      inputs: [
        "scripts/write-cli-startup-metadata.ts",
        "scripts/lib/cli-startup-root-help-bundle.ts",
      ],
      outputs: ["dist/cli-startup-metadata.json"],
      restore: "always",
      runOnHit: { finalize: "refresh" },
    },
  },
];

const FULL_BUILD_STEP_LABELS = [
  "plugins:assets:build",
  "tsdown-ai",
  "tsdown-packages",
  "tsdown-unified",
  "external-plugins:local-dist",
  "check-cli-bootstrap-imports",
  "plugins:assets:copy",
  "runtime-postbuild",
  "build-stamp",
  "runtime-postbuild-stamp",
  "write-plugin-sdk-entry-dts",
  "check-plugin-sdk-exports",
  "ui:build",
  "write-build-info",
  "write-cli-startup-metadata",
] as const;

export const BUILD_ALL_PROFILES: Record<string, string[]> = {
  full: [...FULL_BUILD_STEP_LABELS],
  package: ["clean:dist", ...FULL_BUILD_STEP_LABELS],
  ciArtifacts: [
    "plugins:assets:build",
    "tsdown",
    "external-plugins:local-dist",
    "check-cli-bootstrap-imports",
    "plugins:assets:copy",
    "runtime-postbuild",
    "build-stamp",
    "runtime-postbuild-stamp",
    "write-plugin-sdk-entry-dts",
    "check-plugin-sdk-exports",
    "ui:build",
    "write-build-info",
    "write-cli-startup-metadata",
  ],
  gatewayWatch: [
    "tsdown",
    "external-plugins:local-dist",
    "check-cli-bootstrap-imports",
    "runtime-postbuild",
    "build-stamp",
    "runtime-postbuild-stamp",
  ],
  qaRuntime: [
    "plugins:assets:build",
    "tsdown",
    "external-plugins:local-dist",
    "check-cli-bootstrap-imports",
    "plugins:assets:copy",
    "runtime-postbuild",
    "build-stamp",
    "runtime-postbuild-stamp",
  ],
  sourcePerformance: [
    "plugins:assets:build",
    "tsdown",
    "external-plugins:local-dist",
    "check-cli-bootstrap-imports",
    "plugins:assets:copy",
    "runtime-postbuild",
    "build-stamp",
    "runtime-postbuild-stamp",
    "write-build-info",
    "write-cli-startup-metadata",
  ],
  cliStartup: [
    "tsdown",
    "external-plugins:local-dist",
    "check-cli-bootstrap-imports",
    "runtime-postbuild",
    "build-stamp",
    "runtime-postbuild-stamp",
    "write-cli-startup-metadata",
  ],
};

const FULL_RUNTIME_ONLY_STEPS = [
  "plugins:assets:build",
  "tsdown",
  "external-plugins:local-dist",
  "check-cli-bootstrap-imports",
  "plugins:assets:copy",
  "runtime-postbuild",
  "build-stamp",
  "runtime-postbuild-stamp",
  "ui:build",
  "write-build-info",
  "write-cli-startup-metadata",
];

export const BUILD_ALL_PROFILE_STEP_ENV: Record<string, Record<string, NodeJS.ProcessEnv>> = {
  full: {
    tsdown: {
      OPENCLAW_PRESERVE_CLI_STARTUP_METADATA: "1",
    },
    "tsdown-unified": {
      OPENCLAW_PRESERVE_CLI_STARTUP_METADATA: "1",
    },
  },
  package: {
    tsdown: {
      OPENCLAW_PRESERVE_CLI_STARTUP_METADATA: "1",
    },
    "tsdown-unified": {
      OPENCLAW_PRESERVE_CLI_STARTUP_METADATA: "1",
    },
  },
  ciArtifacts: {
    tsdown: {
      // Global declaration emission is ~95% of the tsdown wall clock and PR
      // CI's dist consumers are runtime JS only; the plugin-sdk gate below
      // self-builds its scoped declarations instead. Release/package builds
      // (full profile, docker packaging) keep canonical dts.
      OPENCLAW_RUN_NODE_SKIP_DTS_BUILD: "1",
      OPENCLAW_PRESERVE_CLI_STARTUP_METADATA: "1",
    },
    "write-plugin-sdk-entry-dts": {
      OPENCLAW_PLUGIN_SDK_CANONICAL_DTS: "0",
    },
  },
  gatewayWatch: {
    tsdown: {
      OPENCLAW_RUN_NODE_SKIP_DTS_BUILD: "1",
    },
    "runtime-postbuild": {
      OPENCLAW_RUNTIME_POSTBUILD_STATIC_ASSETS: "0",
    },
  },
  qaRuntime: {
    tsdown: {
      OPENCLAW_RUN_NODE_SKIP_DTS_BUILD: "1",
    },
  },
  sourcePerformance: {
    tsdown: {
      OPENCLAW_RUN_NODE_SKIP_DTS_BUILD: "1",
      OPENCLAW_PRESERVE_CLI_STARTUP_METADATA: "1",
    },
  },
  cliStartup: {
    tsdown: {
      OPENCLAW_RUN_NODE_SKIP_DTS_BUILD: "1",
      OPENCLAW_PRESERVE_CLI_STARTUP_METADATA: "1",
    },
    "runtime-postbuild": {
      OPENCLAW_RUNTIME_POSTBUILD_STATIC_ASSETS: "0",
    },
  },
};

function buildAllUsage() {
  return [
    "Usage: node --import tsx scripts/build-all.mts [profile]",
    "",
    "Builds OpenClaw artifacts for the selected profile.",
    "",
    "Profiles:",
    ...Object.keys(BUILD_ALL_PROFILES).map((profile) => `  ${profile}`),
    "",
    "Options:",
    "  -h, --help  Show this help.",
  ].join("\n");
}

export function parseBuildAllArgs(argv: string[]) {
  const args = {
    help: false,
    profile: "full",
  };
  let sawProfile = false;
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else if (arg.startsWith("-")) {
      throw new Error(`unknown argument: ${arg}\n\n${buildAllUsage()}`);
    } else if (sawProfile) {
      throw new Error(`unexpected argument: ${arg}\n\n${buildAllUsage()}`);
    } else {
      args.profile = arg;
      sawProfile = true;
    }
  }
  if (!args.help && !BUILD_ALL_PROFILES[args.profile]) {
    throw new Error(`Unknown build profile: ${args.profile}\n\n${buildAllUsage()}`);
  }
  return args;
}

export function resolveBuildAllSteps(
  profile = "full",
  buildEnv: NodeJS.ProcessEnv = process.env,
): BuildAllStep[] {
  const profileLabels = BUILD_ALL_PROFILES[profile];
  if (!profileLabels) {
    throw new Error(`Unknown build profile: ${profile}`);
  }
  // A cold runtime-only build has no declarations for the canonical SDK gates.
  // Keep the full runtime artifact surface, but use the uncached runtime graph.
  const runtimeOnly = buildEnv[RUN_NODE_SKIP_DTS_BUILD_ENV] === "1";
  const labels =
    profile === "full" && runtimeOnly
      ? FULL_RUNTIME_ONLY_STEPS
      : profile === "package" && runtimeOnly
        ? ["clean:dist", ...FULL_RUNTIME_ONLY_STEPS]
        : profileLabels;
  const selected = labels.map((label) => BUILD_ALL_STEPS.find((step) => step.label === label));
  if (selected.some((step) => !step)) {
    const missing = labels.filter((label) => !BUILD_ALL_STEPS.some((step) => step.label === label));
    throw new Error(`Build profile ${profile} references unknown steps: ${missing.join(", ")}`);
  }
  const envOverrides = BUILD_ALL_PROFILE_STEP_ENV[profile] ?? {};
  return selected
    .filter((step): step is NonNullable<typeof step> => step !== undefined)
    .map((step) => {
      const env = envOverrides[step.label];
      if (!env) {
        return step;
      }
      const mergedEnv = Object.assign({}, "env" in step ? step.env : undefined, env);
      const merged: BuildAllStep = Object.assign({}, step, { env: mergedEnv });
      // Self-built declarations need both the complete repository-owned type
      // graph and the flat declarations that this step generates after tsdown
      // clears dist. Canonical mode keeps its narrower generated-dts cache.
      if (
        step.label === "write-plugin-sdk-entry-dts" &&
        mergedEnv.OPENCLAW_PLUGIN_SDK_CANONICAL_DTS !== "1"
      ) {
        merged.cache = {
          ...step.cache,
          inputs: PLUGIN_SDK_SELF_BUILT_ENTRY_DTS_CACHE_INPUTS,
          outputs: PLUGIN_SDK_SELF_BUILT_ENTRY_DTS_CACHE_OUTPUTS,
        };
      }
      return merged;
    });
}

function readCurrentGitCommit() {
  const result = spawnSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

/** Pin one source identity for every child process that contributes to this build. */
export function resolveBuildAllEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  now: () => Date = () => new Date(),
  readGitCommit: () => string | null = readCurrentGitCommit,
) {
  const buildEnv = resolveBuildIdentityEnvironment({
    commitLabel: "build commit",
    env,
    now,
    readGitCommit,
  });
  // Older installed updaters already send this marker to candidate builds.
  // Updates need runtime artifacts; explicit declaration/package builds still win.
  if (buildEnv.OPENCLAW_UPDATE_IN_PROGRESS === "1") {
    buildEnv[RUN_NODE_SKIP_DTS_BUILD_ENV] ??= "1";
  }
  return buildEnv;
}

export function resolveBuildAllTsdownPlan(
  profile: string,
  env: NodeJS.ProcessEnv,
  params: Omit<MemoryLimitParams, "env"> = {},
): {
  env: NodeJS.ProcessEnv;
  heapShortfall: ReturnType<typeof resolveTsdownBuildPlan>["heapShortfall"];
} {
  if (profile !== "full" && profile !== "package" && profile !== "ciArtifacts") {
    return { env, heapShortfall: null };
  }
  const plan = resolveTsdownBuildPlan({ ...params, env });
  return {
    // Direct Node steps need NODE_OPTIONS; tsdown descendants also need the frozen budget.
    env: { ...plan.env, [TSDOWN_MAX_OLD_SPACE_MB_ENV]: String(plan.maxOldSpaceMb) },
    heapShortfall: plan.heapShortfall,
  };
}

function resolveStepEnv(step: BuildAllStep, env: NodeJS.ProcessEnv, platform: NodeJS.Platform) {
  const stepEnv = step.env ? Object.assign({}, env, step.env) : env;
  if (platform !== "win32" || !step.windowsNodeOptions) {
    return stepEnv;
  }
  const currentNodeOptions = stepEnv.NODE_OPTIONS?.trim() ?? "";
  if (currentNodeOptions.includes(step.windowsNodeOptions)) {
    return stepEnv;
  }
  return {
    ...stepEnv,
    NODE_OPTIONS: currentNodeOptions
      ? `${currentNodeOptions} ${step.windowsNodeOptions}`
      : step.windowsNodeOptions,
  };
}

export function resolveBuildAllStep(step: BuildAllStep, params: BuildAllStepParams = {}) {
  const platform = params.platform ?? process.platform;
  const env = resolveStepEnv(step, params.env ?? process.env, platform);
  if (step.kind === "pnpm") {
    const nodeFallbackArgs =
      env.OPENCLAW_BUILD_ALL_NO_PNPM === "1" ? PNPM_STEP_NODE_FALLBACKS.get(step.label) : undefined;
    if (nodeFallbackArgs) {
      return {
        command: params.nodeExecPath ?? nodeBin,
        args: nodeFallbackArgs,
        options: {
          stdio: "inherit",
          env,
        } satisfies SpawnSyncOptions,
      };
    }
    const runner = resolvePnpmRunner({
      env,
      pnpmArgs: step.pnpmArgs,
      nodeExecPath: params.nodeExecPath ?? nodeBin,
      npmExecPath: params.npmExecPath ?? env.npm_execpath,
      comSpec: params.comSpec,
      platform,
    });
    return {
      command: runner.command,
      args: runner.args,
      options: {
        stdio: "inherit",
        env,
        shell: runner.shell,
        windowsVerbatimArguments: runner.windowsVerbatimArguments,
      } satisfies SpawnSyncOptions,
    };
  }
  return {
    command: params.nodeExecPath ?? nodeBin,
    args: step.args,
    options: {
      stdio: "inherit",
      env,
    } satisfies SpawnSyncOptions,
  };
}

export function resolveBuildAllStepOnCacheHit(step: BuildAllStep) {
  if (!step.cache?.runOnHit) {
    return null;
  }
  return {
    ...step,
    env: Object.assign({}, step.env, step.cache.runOnHit.env),
  };
}

function cacheEntryIncludesFile(entry: BuildCachePath, filePath: string) {
  if (!entry.extensions?.length) {
    return true;
  }
  return entry.extensions.some((extension) => filePath.endsWith(extension));
}

function listFilesRecursively(
  rootPath: string,
  fsImpl: BuildAllFs,
  cacheEntry: BuildCachePath = { path: rootPath },
) {
  let stat;
  try {
    stat = fsImpl.statSync(rootPath);
  } catch {
    return [];
  }
  if (stat.isFile()) {
    return cacheEntryIncludesFile(cacheEntry, rootPath) ? [rootPath] : [];
  }
  if (!stat.isDirectory()) {
    return [];
  }
  const out: string[] = [];
  const entries = fsImpl.readdirSync(rootPath, { withFileTypes: true });
  const recursive = cacheEntry.recursive !== false;
  for (const dirent of entries) {
    if (dirent.name === ".DS_Store") {
      continue;
    }
    const entryPath = path.join(rootPath, dirent.name);
    if (dirent.isDirectory() && cacheEntry.excludeDirectories?.includes(dirent.name)) {
      continue;
    }
    if (dirent.isDirectory() && recursive) {
      out.push(...listFilesRecursively(entryPath, fsImpl, cacheEntry));
    } else if (dirent.isFile() && cacheEntryIncludesFile(cacheEntry, entryPath)) {
      out.push(entryPath);
    }
  }
  return out;
}

function listCacheFiles(rootDir: string, entries: BuildCacheEntry[], fsImpl: BuildAllFs) {
  return entries
    .map((entry) => (typeof entry === "string" ? { path: entry } : entry))
    .flatMap((entry) => listFilesRecursively(path.resolve(rootDir, entry.path), fsImpl, entry))
    .toSorted();
}

function portableRelativePath(rootDir: string, filePath: string) {
  return path.relative(rootDir, filePath).split(path.sep).join("/");
}

function normalizePortablePath(filePath: string) {
  return filePath.replaceAll("\\", "/");
}

function resolveCacheRequiredOutputs(cache: BuildCache, env: NodeJS.ProcessEnv) {
  const outputs =
    typeof cache.requiredOutputs === "function"
      ? cache.requiredOutputs(env)
      : (cache.requiredOutputs ?? []);
  return outputs.map((output) => normalizePortablePath(output));
}

function resolveBuildCacheRoot(rootDir: string, env: NodeJS.ProcessEnv) {
  // Dev update preflight and final builds run in separate worktrees. A shared
  // root lets content signatures decide reuse without relocating built trees.
  const configuredRoot = env?.BUILD_ALL_CACHE_ROOT?.trim();
  if (!configuredRoot) {
    return path.resolve(rootDir, ".artifacts/build-all-cache");
  }
  return path.isAbsolute(configuredRoot)
    ? path.normalize(configuredRoot)
    : path.resolve(rootDir, configuredRoot);
}

function resolveCachePaths(rootDir: string, step: BuildCacheStep, env: NodeJS.ProcessEnv) {
  const safeLabel = step.label.replace(/[^a-zA-Z0-9._-]+/g, "_");
  const cacheDir = path.join(resolveBuildCacheRoot(rootDir, env), safeLabel);
  return {
    cacheDir,
    outputRoot: path.join(cacheDir, "outputs"),
    stampPath: path.join(cacheDir, "stamp.json"),
  };
}

function hashInputFiles(
  rootDir: string,
  files: string[],
  fsImpl: BuildAllFs,
  envEntries: string[] = [],
  env: NodeJS.ProcessEnv = process.env,
) {
  const hash = createHash("sha256");
  hash.update(`v${BUILD_CACHE_VERSION}\0`);
  for (const name of envEntries.toSorted((left, right) => left.localeCompare(right))) {
    hash.update(`env:${name}`);
    hash.update("\0");
    hash.update(env[name] ?? "");
    hash.update("\0");
  }
  for (const file of files) {
    hash.update(portableRelativePath(rootDir, file));
    hash.update("\0");
    hash.update(fsImpl.readFileSync(file));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function readCacheStamp(stampPath: string, fsImpl: BuildAllFs) {
  try {
    const stamp = asRecord(JSON.parse(fsImpl.readFileSync(stampPath, "utf8")));
    const { version, signature, outputs: rawOutputs } = stamp;
    const outputs = Array.isArray(rawOutputs)
      ? rawOutputs.filter((entry) => typeof entry === "string")
      : undefined;
    return {
      version: typeof version === "number" ? version : undefined,
      signature: typeof signature === "string" ? signature : undefined,
      outputs,
    };
  } catch {
    return undefined;
  }
}

function hasAllFiles(rootDir: string, relativeFiles: string[], fsImpl: BuildAllFs) {
  return relativeFiles.every((relativeFile) => {
    try {
      return fsImpl.statSync(path.resolve(rootDir, relativeFile)).isFile();
    } catch {
      return false;
    }
  });
}

function copyFileSync(fsImpl: BuildAllFs, sourcePath: string, targetPath: string) {
  fsImpl.mkdirSync(path.dirname(targetPath), { recursive: true });
  fsImpl.copyFileSync(sourcePath, targetPath);
}

export function resolveBuildAllStepCacheState(
  step: BuildCacheStep,
  params: BuildAllCacheParams = {},
) {
  if (!step.cache) {
    return { cacheable: false, fresh: false, reason: "no-cache" };
  }
  const rootDir = params.rootDir ?? process.cwd();
  const fsImpl = params.fs ?? fs;
  const inputFiles = listCacheFiles(rootDir, step.cache.inputs, fsImpl);
  if (inputFiles.length === 0) {
    return { cacheable: true, fresh: false, reason: "missing-inputs" };
  }
  const signature = hashInputFiles(
    rootDir,
    inputFiles,
    fsImpl,
    step.cache.env ?? [],
    params.env ?? process.env,
  );
  const { outputRoot, stampPath } = resolveCachePaths(rootDir, step, params.env ?? process.env);
  const stamp = readCacheStamp(stampPath, fsImpl);
  const outputFiles = listCacheFiles(rootDir, step.cache.outputs, fsImpl);
  const relativeOutputFiles = outputFiles.map((file) => portableRelativePath(rootDir, file));
  const stampedOutputs = stamp?.outputs?.map((entry) => normalizePortablePath(entry)) ?? [];
  const requiredOutputs = resolveCacheRequiredOutputs(step.cache, params.env ?? process.env);
  const stampedOutputSet = new Set(stampedOutputs);
  // Restore trusts the stamp inventory, so legacy partial stamps must name the
  // complete current contract before either output tree can make them fresh.
  const stampIncludesRequiredOutputs = requiredOutputs.every((output) =>
    stampedOutputSet.has(output),
  );
  const stampMatches =
    stamp?.version === BUILD_CACHE_VERSION &&
    stamp.signature === signature &&
    stampIncludesRequiredOutputs;
  const actualOutputsPresent =
    stampedOutputs.length > 0 && hasAllFiles(rootDir, stampedOutputs, fsImpl);
  const cachedOutputsPresent =
    stampedOutputs.length > 0 && hasAllFiles(outputRoot, stampedOutputs, fsImpl);
  const cacheHitContractMatches =
    stampMatches && hasAllFiles(rootDir, step.cache.requiredCacheHitOutputs ?? [], fsImpl);
  const alwaysRestore = step.cache.restore === "always";
  const actualOutputsAcceptable = actualOutputsPresent && !alwaysRestore;
  const restorable =
    cacheHitContractMatches && cachedOutputsPresent && (alwaysRestore || !actualOutputsPresent);
  const fresh = cacheHitContractMatches && (actualOutputsAcceptable || cachedOutputsPresent);
  return {
    cacheable: true,
    fresh,
    restorable,
    reason: fresh ? (restorable ? "fresh-cache" : "fresh") : "stale",
    signature,
    outputRoot,
    stampPath,
    inputFiles: inputFiles.length,
    outputFiles: outputFiles.length,
    relativeOutputFiles,
    stampedOutputs,
  };
}

type BuildAllCacheState = ReturnType<typeof resolveBuildAllStepCacheState>;

export function writeBuildAllStepCacheStamp(
  step: BuildCacheStep,
  cacheState: BuildAllCacheState,
  params: Pick<BuildAllCacheParams, "rootDir" | "fs" | "env"> = {},
) {
  if (
    !step.cache ||
    !cacheState.cacheable ||
    !cacheState.signature ||
    !cacheState.stampPath ||
    !cacheState.outputRoot ||
    !cacheState.relativeOutputFiles?.length
  ) {
    return;
  }
  const fsImpl = params.fs ?? fs;
  const rootDir = params.rootDir ?? process.cwd();
  const requiredOutputs = resolveCacheRequiredOutputs(step.cache, params.env ?? process.env);
  const relativeOutputSet = new Set(
    cacheState.relativeOutputFiles.map((output) => normalizePortablePath(output)),
  );
  // Validate before copying so an incomplete run cannot mutate the cached tree
  // while leaving its previous stamp in place.
  if (
    !requiredOutputs.every((output) => relativeOutputSet.has(output)) ||
    !hasAllFiles(rootDir, requiredOutputs, fsImpl)
  ) {
    return;
  }
  for (const relativeFile of cacheState.relativeOutputFiles) {
    copyFileSync(
      fsImpl,
      path.resolve(rootDir, relativeFile),
      path.resolve(cacheState.outputRoot, relativeFile),
    );
  }
  fsImpl.mkdirSync(path.dirname(cacheState.stampPath), { recursive: true });
  fsImpl.writeFileSync(
    cacheState.stampPath,
    `${JSON.stringify({
      version: BUILD_CACHE_VERSION,
      label: step.label,
      signature: cacheState.signature,
      outputs: cacheState.relativeOutputFiles,
    })}\n`,
  );
}

export function resolveBuildAllStepCacheStampState(
  step: BuildCacheStep,
  cacheState: BuildAllCacheState,
  params: Pick<BuildAllCacheParams, "rootDir" | "fs"> = {},
) {
  if (!cacheState.cacheable || !cacheState.signature || !step.cache) {
    return cacheState;
  }
  const rootDir = params.rootDir ?? process.cwd();
  const fsImpl = params.fs ?? fs;
  const outputFiles = listCacheFiles(rootDir, step.cache.outputs, fsImpl);
  return {
    ...cacheState,
    outputFiles: outputFiles.length,
    relativeOutputFiles: outputFiles.map((file) => portableRelativePath(rootDir, file)),
  };
}

export function restoreBuildAllStepCacheOutputs(
  cacheState: BuildAllCacheState,
  params: Pick<BuildAllCacheParams, "rootDir" | "fs"> = {},
) {
  if (!cacheState.restorable || !cacheState.outputRoot || !cacheState.stampedOutputs?.length) {
    return false;
  }
  const fsImpl = params.fs ?? fs;
  const rootDir = params.rootDir ?? process.cwd();
  const stampedOutputSet = new Set(cacheState.stampedOutputs);
  // A restored snapshot owns its declared output set. Remove older checkout
  // outputs first so cache hits cannot combine declarations from two builds.
  for (const relativeFile of cacheState.relativeOutputFiles ?? []) {
    if (!stampedOutputSet.has(normalizePortablePath(relativeFile))) {
      fsImpl.rmSync(path.resolve(rootDir, relativeFile), { force: true });
    }
  }
  for (const relativeFile of cacheState.stampedOutputs) {
    copyFileSync(
      fsImpl,
      path.resolve(cacheState.outputRoot, relativeFile),
      path.resolve(rootDir, relativeFile),
    );
  }
  return true;
}

export function finalizeBuildAllStepCache(
  step: BuildCacheStep,
  cacheState: BuildAllCacheState,
  params: BuildAllCacheParams & { reusedCache?: boolean } = {},
) {
  if (params.reusedCache && step.cache?.runOnHit?.finalize !== "refresh") {
    return restoreBuildAllStepCacheOutputs(cacheState, params);
  }
  // Validator-style cache hits may update a restored seed. Capture that result;
  // restoring the old seed here would silently discard the validated refresh.
  writeBuildAllStepCacheStamp(
    step,
    resolveBuildAllStepCacheStampState(step, cacheState, params),
    params,
  );
  return true;
}

export function formatBuildAllDuration(durationMs: number) {
  const clampedMs = Math.max(0, durationMs);
  const roundedMs =
    clampedMs < 1000
      ? Math.round(clampedMs)
      : clampedMs < 10_000
        ? Math.round(clampedMs / 10) * 10
        : Math.round(clampedMs / 100) * 100;
  return prettyMilliseconds(roundedMs, {
    secondsDecimalDigits: clampedMs < 10_000 ? 2 : 1,
  });
}

export function formatBuildAllTimingSummary(timings: BuildAllTiming[]) {
  if (timings.length === 0) {
    return "[build-all] phase timings: no phases ran";
  }
  const totalMs = timings.reduce((sum, timing) => sum + timing.durationMs, 0);
  const phases = timings
    .toSorted((left, right) => right.durationMs - left.durationMs)
    .map((timing) => {
      const status = timing.status === "ran" ? "" : ` (${timing.status})`;
      return `${timing.label}${status} ${formatBuildAllDuration(timing.durationMs)}`;
    })
    .join("; ");
  return `[build-all] phase timings: total ${formatBuildAllDuration(totalMs)}; slowest ${phases}`;
}

export function runBuildAllSteps(
  profile: string,
  params: {
    cacheEnabled?: boolean;
    env?: NodeJS.ProcessEnv;
    finalizeCache?: typeof finalizeBuildAllStepCache;
    logger?: Pick<Console, "error" | "warn">;
    memoryLimit?: Omit<MemoryLimitParams, "env">;
    now?: () => number;
    resolveCacheState?: typeof resolveBuildAllStepCacheState;
    restoreCache?: typeof restoreBuildAllStepCacheOutputs;
    runStep?: (invocation: ReturnType<typeof resolveBuildAllStep>) => { status: number | null };
    steps?: BuildAllStep[];
  } = {},
) {
  const { env: buildEnv, heapShortfall } = resolveBuildAllTsdownPlan(
    profile,
    resolveBuildAllEnvironment(params.env),
    params.memoryLimit,
  );
  const steps = params.steps ?? resolveBuildAllSteps(profile, buildEnv);
  const cacheEnabled = params.cacheEnabled ?? buildEnv.OPENCLAW_BUILD_CACHE !== "0";
  const logger = params.logger ?? console;
  const now = params.now ?? performance.now.bind(performance);
  const resolveCacheState = params.resolveCacheState ?? resolveBuildAllStepCacheState;
  const restoreCache = params.restoreCache ?? restoreBuildAllStepCacheOutputs;
  const finalizeCache = params.finalizeCache ?? finalizeBuildAllStepCache;
  const runStep =
    params.runStep ??
    ((invocation: ReturnType<typeof resolveBuildAllStep>) =>
      spawnSync(invocation.command, invocation.args, invocation.options));
  const timings: BuildAllTiming[] = [];
  let exitCode = 0;
  if (heapShortfall) {
    if (heapShortfall.fatal) {
      logger.error(heapShortfall.message);
      return { exitCode: 1, timings };
    }
    logger.warn(heapShortfall.message);
  }
  for (const step of steps) {
    const cacheStartedAt = now();
    const cacheState = resolveCacheState(step, { env: buildEnv });
    const cacheDurationMs = now() - cacheStartedAt;
    const startedAt = now();
    let stepToRun = step;
    let reusedCache = false;
    if (cacheEnabled && cacheState.fresh) {
      restoreCache(cacheState);
      const cacheHitStep = resolveBuildAllStepOnCacheHit(step);
      if (!cacheHitStep) {
        const durationMs = cacheDurationMs + now() - startedAt;
        timings.push({ label: step.label, status: "cached", durationMs });
        logger.error(`[build-all] ${step.label} (cached) ${formatBuildAllDuration(durationMs)}`);
        continue;
      }
      reusedCache = true;
      stepToRun = cacheHitStep;
    }
    logger.error(`[build-all] ${step.label}${reusedCache ? " (cache restored)" : ""}`);
    const invocation = resolveBuildAllStep(stepToRun, { env: buildEnv });
    const result = runStep(invocation);
    const durationMs = cacheDurationMs + now() - startedAt;
    if (typeof result.status === "number") {
      if (result.status !== 0) {
        timings.push({ label: step.label, status: "failed", durationMs });
        logger.error(
          `[build-all] ${step.label} failed after ${formatBuildAllDuration(durationMs)}`,
        );
        exitCode = result.status;
        break;
      }
      // Runtime-only tsdown cleans its output roots. Cache hits restore
      // declarations again after that pass so the full build stays complete.
      finalizeCache(step, cacheState, { env: buildEnv, reusedCache });
      timings.push({ label: step.label, status: reusedCache ? "reused" : "ran", durationMs });
      logger.error(`[build-all] ${step.label} done in ${formatBuildAllDuration(durationMs)}`);
      continue;
    }
    timings.push({ label: step.label, status: "failed", durationMs });
    logger.error(`[build-all] ${step.label} failed after ${formatBuildAllDuration(durationMs)}`);
    exitCode = 1;
    break;
  }
  logger.error(formatBuildAllTimingSummary(timings));
  return { exitCode, timings };
}

if (isDirectRunUrl(process.argv[1], import.meta.url)) {
  let args;
  try {
    args = parseBuildAllArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
  if (args?.help) {
    console.log(buildAllUsage());
  } else {
    const result = runBuildAllSteps(args.profile);
    if (result.exitCode !== 0) {
      process.exit(result.exitCode);
    }
  }
}
