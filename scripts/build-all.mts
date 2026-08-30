#!/usr/bin/env node
// Builds OpenClaw packages and plugin SDK artifacts with cache-aware orchestration.

import { spawnSync, type SpawnSyncOptions } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import prettyMilliseconds from "pretty-ms";
import {
  acquireBuildArtifactLock,
  artifactRecordMatches,
  collectArtifactRecord,
  readArtifactRecord,
  writeArtifactRecord,
  publishArtifactFiles,
  resolveTsdownCompilerIdentity,
  hashInputFiles,
  listCacheFiles,
  portableRelativePath,
  type BuildCacheEntry,
} from "./lib/build-artifact-cache.mts";
import { resolveBuildIdentityEnvironment } from "./lib/build-identity.mts";
import { isDirectRunUrl } from "./lib/direct-run.mjs";
import {
  distArtifactEntryArgs,
  withDistArtifactOwnership,
} from "./lib/dist-artifact-ownership.mts";
import { runManagedCommand } from "./lib/managed-child-process.mts";
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
export type { BuildCacheEntry } from "./lib/build-artifact-cache.mts";

const nodeBin = process.execPath;

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
  "scripts/lib/build-artifact-cache.mts",
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
  tsxStep("write-plugin-sdk-entry-dts", "scripts/write-plugin-sdk-entry-dts.ts"),
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
      // stages the two canonical SDK declaration groups instead. Release/package builds
      // (full profile, docker packaging) keep canonical dts.
      OPENCLAW_RUN_NODE_SKIP_DTS_BUILD: "1",
      OPENCLAW_PRESERVE_CLI_STARTUP_METADATA: "1",
    },
    "write-plugin-sdk-entry-dts": {
      OPENCLAW_RUN_NODE_SKIP_DTS_BUILD: "0",
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

function hasAllFiles(rootDir: string, relativeFiles: string[], fsImpl: BuildAllFs) {
  return relativeFiles.every((relativeFile) => {
    try {
      return fsImpl.statSync(path.resolve(rootDir, relativeFile)).isFile();
    } catch {
      return false;
    }
  });
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
    step.label.startsWith("tsdown") ? resolveTsdownCompilerIdentity() : "",
  );
  const { outputRoot, stampPath } = resolveCachePaths(rootDir, step, params.env ?? process.env);
  const lock = acquireBuildArtifactLock(stampPath);
  try {
    const stamp = readArtifactRecord(stampPath);
    const outputFiles = listCacheFiles(rootDir, step.cache.outputs, fsImpl);
    const relativeOutputFiles = outputFiles.map((file) => portableRelativePath(rootDir, file));
    const stampedOutputs = Object.keys(stamp?.outputs ?? {});
    const requiredOutputs = resolveCacheRequiredOutputs(step.cache, params.env ?? process.env);
    const actualOutputsPresent = artifactRecordMatches(rootDir, stamp, signature, requiredOutputs);
    const cachedOutputsPresent = artifactRecordMatches(
      outputRoot,
      stamp,
      signature,
      requiredOutputs,
    );
    const stampMatches = stamp?.signature === signature;
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
      record: stamp,
    };
  } finally {
    lock.release();
  }
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
  const lock = acquireBuildArtifactLock(cacheState.stampPath);
  try {
    const record = collectArtifactRecord(
      rootDir,
      cacheState.signature,
      cacheState.relativeOutputFiles,
    );
    const previous = readArtifactRecord(cacheState.stampPath);
    // Invalidate before the first copied byte; readers and publishers use this
    // same lock, so neither crashes nor overlap can expose a partial snapshot.
    fsImpl.rmSync(cacheState.stampPath, { force: true });
    publishArtifactFiles(
      rootDir,
      cacheState.outputRoot,
      Object.keys(record.outputs),
      Object.keys(previous?.outputs ?? {}),
    );
    if (
      !artifactRecordMatches(cacheState.outputRoot, record, cacheState.signature, requiredOutputs)
    ) {
      throw new Error(`Incomplete build cache snapshot: ${step.label}`);
    }
    writeArtifactRecord(cacheState.stampPath, record);
  } finally {
    lock.release();
  }
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
  if (!cacheState.stampPath || !cacheState.signature || !cacheState.record) {
    return false;
  }
  const lock = acquireBuildArtifactLock(cacheState.stampPath);
  try {
    const record = readArtifactRecord(cacheState.stampPath);
    if (
      JSON.stringify(record) !== JSON.stringify(cacheState.record) ||
      !artifactRecordMatches(cacheState.outputRoot, record, cacheState.signature)
    ) {
      return false;
    }
    publishArtifactFiles(
      cacheState.outputRoot,
      params.rootDir ?? process.cwd(),
      cacheState.stampedOutputs,
      cacheState.relativeOutputFiles,
    );
    return true;
  } finally {
    lock.release();
  }
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

export async function runBuildAllSteps(
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
    runStep?: (
      invocation: ReturnType<typeof resolveBuildAllStep>,
    ) => { status: number | null } | Promise<{ status: number | null }>;
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
    (async (invocation: ReturnType<typeof resolveBuildAllStep>) => {
      const script = invocation.args[2];
      return {
        status: await runManagedCommand({
          bin: invocation.command,
          args:
            script === "scripts/tsdown-build.mts" ||
            script === "scripts/write-plugin-sdk-entry-dts.ts"
              ? distArtifactEntryArgs(script, invocation.args.slice(3))
              : invocation.args,
          ...invocation.options,
          requireProcessTreeExit: process.platform !== "win32",
        }),
      };
    });
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
      if (cacheState.restorable && !restoreCache(cacheState)) {
        throw new Error(`Build cache changed before restoration: ${step.label}; rerun the build`);
      }
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
    const result = await runStep(invocation);
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
      if (!finalizeCache(step, cacheState, { env: buildEnv, reusedCache })) {
        throw new Error(`Build cache changed during ${step.label}; rerun the build`);
      }
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
    const result = await withDistArtifactOwnership(process.cwd(), () =>
      runBuildAllSteps(args.profile),
    );
    if (result.exitCode !== 0) {
      process.exit(result.exitCode);
    }
  }
}
