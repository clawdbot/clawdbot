#!/usr/bin/env node
// Builds OpenClaw packages and plugin SDK artifacts with cache-aware orchestration.

import { spawnSync, type SpawnSyncOptions } from "node:child_process";
import { performance } from "node:perf_hooks";
import prettyMilliseconds from "pretty-ms";
import {
  finalizeBuildStepCache,
  resolveBuildStepCacheState,
  restoreBuildStepCacheOutputs,
  type BuildCacheStep,
} from "./lib/build-artifact-cache.mts";
import { resolveBuildIdentityEnvironment } from "./lib/build-identity.mts";
import { isDirectRunUrl } from "./lib/direct-run.mjs";
import {
  distArtifactEntryArgs,
  withDistArtifactOwnership,
} from "./lib/dist-artifact-ownership.mts";
import { runManagedCommand } from "./lib/managed-child-process.mts";
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
  TSDOWN_DECLARATION_EXTENSIONS,
  TSDOWN_DECLARATION_TOOL_INPUTS,
  TSDOWN_PACKAGES_CACHE_INPUT,
  resolveTsdownBuildPlan,
  type MemoryLimitParams,
} from "./tsdown-build.mts";

const nodeBin = process.execPath;

export type BuildAllStep = BuildCacheStep &
  (
    | { kind: "pnpm"; args?: never; pnpmArgs: string[]; windowsNodeOptions?: string }
    | { kind?: "node"; args: string[]; pnpmArgs?: never; windowsNodeOptions?: string }
  );

type BuildAllTiming = { label: string; durationMs: number; status: string };
type BuildAllStepParams = {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  nodeExecPath?: string;
  npmExecPath?: string;
  comSpec?: string;
};
const RUN_NODE_SKIP_DTS_BUILD_ENV = "OPENCLAW_RUN_NODE_SKIP_DTS_BUILD";
const TSDOWN_AI_OUTPUT_ROOT = tsdownPackageOutputRoot("ai");
const TSDOWN_MAIN_PACKAGE_OUTPUT_ROOTS = TSDOWN_PACKAGE_OUTPUT_ROOTS.filter(
  (root) => root !== TSDOWN_AI_OUTPUT_ROOT,
);
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
    env: { OPENCLAW_RUN_NODE_SKIP_DTS_BUILD: "1" },
  },
  {
    ...tsxStep("write-unified-entry-dts", "scripts/write-unified-entry-dts.ts"),
    env: { OPENCLAW_RUN_NODE_SKIP_DTS_BUILD: "0" },
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
    env: { OPENCLAW_RUN_NODE_SKIP_DTS_BUILD: "0" },
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

const RUNTIME_SETUP_STEP_LABELS = [
  "external-plugins:local-dist",
  "check-cli-bootstrap-imports",
] as const;
const RUNTIME_FINALIZE_STEP_LABELS = [
  "runtime-postbuild",
  "build-stamp",
  "runtime-postbuild-stamp",
] as const;
const RUNTIME_STEP_LABELS = [...RUNTIME_SETUP_STEP_LABELS, ...RUNTIME_FINALIZE_STEP_LABELS];
const ASSET_RUNTIME_STEP_LABELS = [
  "plugins:assets:build",
  "tsdown",
  ...RUNTIME_SETUP_STEP_LABELS,
  // Copy after compiler cleanup, before postbuild records the generated asset inventory.
  "plugins:assets:copy",
  ...RUNTIME_FINALIZE_STEP_LABELS,
];
const BUILD_METADATA_STEP_LABELS = ["write-build-info", "write-cli-startup-metadata"] as const;
const FINAL_BUILD_ARTIFACTS_STEP_LABELS = [
  "write-plugin-sdk-entry-dts",
  "check-plugin-sdk-exports",
  "ui:build",
  ...BUILD_METADATA_STEP_LABELS,
] as const;
const CI_ARTIFACT_STEP_LABELS = [
  ...ASSET_RUNTIME_STEP_LABELS,
  ...FINAL_BUILD_ARTIFACTS_STEP_LABELS,
];
const FULL_COMPILER_STEP_LABELS = [
  "tsdown-ai",
  "tsdown-packages",
  "tsdown-unified",
  "write-unified-entry-dts",
] as const;
// Full and package builds cache declaration groups separately from the runtime graph.
const FULL_BUILD_STEP_LABELS = CI_ARTIFACT_STEP_LABELS.flatMap((step) =>
  step === "tsdown" ? FULL_COMPILER_STEP_LABELS : [step],
);

export const BUILD_ALL_PROFILES: Record<string, string[]> = {
  full: [...FULL_BUILD_STEP_LABELS],
  package: ["clean:dist", ...FULL_BUILD_STEP_LABELS],
  ciArtifacts: [...CI_ARTIFACT_STEP_LABELS],
  gatewayWatch: ["tsdown", ...RUNTIME_STEP_LABELS],
  qaRuntime: [...ASSET_RUNTIME_STEP_LABELS],
  sourcePerformance: [...ASSET_RUNTIME_STEP_LABELS, ...BUILD_METADATA_STEP_LABELS],
  cliStartup: ["tsdown", ...RUNTIME_STEP_LABELS, "write-cli-startup-metadata"],
};

const FULL_RUNTIME_ONLY_STEPS = [
  ...ASSET_RUNTIME_STEP_LABELS,
  "ui:build",
  ...BUILD_METADATA_STEP_LABELS,
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
  // Its uncached graph cannot seed the declaration-only caches used by full builds.
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
      // Source-run rebuilds share qaRuntime but retain the caller's explicit
      // declaration choice. The other partial profiles remain runtime-only.
      if (profile === "qaRuntime" && step.label === "tsdown") {
        mergedEnv[RUN_NODE_SKIP_DTS_BUILD_ENV] =
          buildEnv[RUN_NODE_SKIP_DTS_BUILD_ENV] ?? mergedEnv[RUN_NODE_SKIP_DTS_BUILD_ENV];
      }
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
    finalizeCache?: typeof finalizeBuildStepCache;
    logger?: Pick<Console, "error" | "warn">;
    memoryLimit?: Omit<MemoryLimitParams, "env">;
    now?: () => number;
    resolveCacheState?: typeof resolveBuildStepCacheState;
    restoreCache?: typeof restoreBuildStepCacheOutputs;
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
  const resolveCacheState = params.resolveCacheState ?? resolveBuildStepCacheState;
  const restoreCache = params.restoreCache ?? restoreBuildStepCacheOutputs;
  const finalizeCache = params.finalizeCache ?? finalizeBuildStepCache;
  const runStep =
    params.runStep ??
    (async (invocation: ReturnType<typeof resolveBuildAllStep>) => {
      const script = invocation.args[2];
      return {
        status: await runManagedCommand({
          bin: invocation.command,
          args:
            script === "scripts/tsdown-build.mts" ||
            script === "scripts/write-unified-entry-dts.ts" ||
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
