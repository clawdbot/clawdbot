import { spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fullSuiteVitestShards } from "../../test/vitest/vitest.test-shards.mjs";
import { runManagedCommand } from "./managed-child-process.mts";
import { resolveRepoRoot } from "./repo-root.mjs";

// A private-QA build also satisfies ordinary runtime readers.
const VITEST_PRETEST_BUILD_MODES = ["private-qa", "runtime"] as const;
export type VitestPretestBuildMode = (typeof VITEST_PRETEST_BUILD_MODES)[number];
type SetupCommandRunner = (args: string[], env: NodeJS.ProcessEnv) => Promise<number>;

export type VitestRuntimeTestSelection = {
  configs?: readonly string[];
  includePatterns?: readonly string[] | null;
  matchesFile?: (
    file: string,
    included: boolean,
    includePatterns: readonly string[] | null | undefined,
  ) => boolean;
};

// These tests consume built runtime artifacts. Prepare their strongest
// prerequisite before admitting any workers: a child build invalidates dist
// while unrelated workers may still be importing its public plugin facades.
const runtimeConsumers = [
  {
    file: "test/agent-exec-code-mode.live.test.ts",
    configs: ["test/vitest/vitest.live.config.ts"],
    mode: "runtime",
    dir: "",
  },
  {
    file: "extensions/qa-lab/src/suite-process-lifecycle.test.ts",
    configs: ["test/vitest/vitest.extension-qa.config.ts"],
    mode: "private-qa",
    dir: "extensions",
  },
  ...[
    "src/cli/acp-cli-exit.process.test.ts",
    "src/cli/update-dry-run-state.process.test.ts",
    "src/cli/update-cli/update-command-migrated.test.ts",
    "src/cli/update-cli/update-command-rollback.test.ts",
    "src/cli/update-cli/update-command-post-update-recovery.test.ts",
    "src/cli/update-cli/update-command-post-update-repair.test.ts",
    "src/cli/update-cli/update-command-service.integration.test.ts",
  ].map((file) => ({
    file,
    configs: ["test/vitest/vitest.cli-process.config.ts"],
    mode: "runtime" as const,
    dir: "",
  })),
  ...[
    "src/infra/update-candidate-canary.integration.test.ts",
    "src/infra/update-managed-service-handoff-lifecycle.test.ts",
  ].map((file) => ({
    file,
    configs: ["test/vitest/vitest.infra.config.ts"],
    mode: "runtime" as const,
    dir: "src",
  })),
  ...[
    "src/commands/doctor-config-preflight.process.test.ts",
    "src/commands/doctor-config-preflight.refusal.process.test.ts",
    "src/commands/doctor-config-preflight.v17-atomicity.process.test.ts",
    "src/commands/doctor-plugin-install-config.process.test.ts",
  ].map((file) => ({
    file,
    configs: ["test/vitest/vitest.commands.config.ts"],
    mode: "runtime" as const,
    dir: "src/commands",
  })),
  {
    file: "test/e2e/qa-lab/runtime/gateway-codex-delivery-cache.test.ts",
    configs: ["test/vitest/vitest.tooling.config.ts"],
    mode: "private-qa",
    dir: "",
  },
  {
    file: "test/e2e/qa-lab/runtime/gateway-support-export-runtime.test.ts",
    configs: ["test/vitest/vitest.tooling.config.ts"],
    mode: "runtime",
    dir: "",
  },
  ...[
    "src/gateway/server-sidecar-retention.test.ts",
    "src/gateway/server.config-patch.test.ts",
  ].map((file) => ({
    file,
    configs: [
      "test/vitest/vitest.gateway-server.config.ts",
      "test/vitest/vitest.gateway.config.ts",
    ],
    mode: "runtime" as const,
    dir: "src/gateway",
  })),
  ...[
    "src/gateway/gateway-active-memory.test.ts",
    "src/gateway/gateway-auth-rewarm.test.ts",
    "src/gateway/gateway-concurrent-streams.test.ts",
    "src/gateway/gateway-cron-process-identity.windows.test.ts",
    "src/gateway/gateway-route-model-reuse.test.ts",
  ].map((file) => ({
    file,
    configs: ["test/vitest/vitest.gateway-core.config.ts", "test/vitest/vitest.gateway.config.ts"],
    mode: "runtime" as const,
    dir: "src/gateway",
  })),
] as const;

function includesRuntimeConfig(configs: readonly string[] | undefined, config: string) {
  return configs?.some(
    (selected) =>
      selected === config ||
      selected === "vitest.config.ts" ||
      selected === "test/vitest/vitest.config.ts" ||
      fullSuiteVitestShards.some(
        (shard) => shard.config === selected && shard.projects.includes(config),
      ),
  );
}

export function resolveVitestRuntimeConfigScopes(config: string) {
  return runtimeConsumers.flatMap(({ configs, dir }) => {
    // Preserve the matched project scope; broad roots must not apply another
    // consumer's directory to scoped exclusions.
    const selected = configs.filter((candidate) => includesRuntimeConfig([config], candidate));
    return selected.length ? [{ configs: selected, dir }] : [];
  });
}

/**
 * Test files under `configs` that need a built runtime. Callers use this to keep
 * those files in one shard: the pretest build is charged per job, so spreading
 * them across stripes makes every stripe pay for it.
 */
export function listVitestRuntimeConsumerFiles(configs: readonly string[]): string[] {
  return runtimeConsumers
    .filter((consumer) =>
      consumer.configs.some((candidate) => includesRuntimeConfig(configs, candidate)),
    )
    .map((consumer) => consumer.file);
}

/** Merge prepared prerequisites without repeating test-file ownership discovery. */
export function mergeVitestPretestBuildModes(
  modes: readonly (VitestPretestBuildMode | undefined)[],
): VitestPretestBuildMode | undefined {
  return VITEST_PRETEST_BUILD_MODES.find((mode) => modes.includes(mode));
}

export function resolveVitestPretestBuildMode(
  selections: readonly VitestRuntimeTestSelection[],
): VitestPretestBuildMode | undefined {
  return mergeVitestPretestBuildModes(
    runtimeConsumers
      .filter(({ file, configs: consumerConfigs }) =>
        selections.some(({ configs, includePatterns, matchesFile }) => {
          const included = includePatterns
            ? includePatterns.some((pattern) => path.matchesGlob(file, pattern))
            : consumerConfigs.some((config) => includesRuntimeConfig(configs, config));
          // Only project the canonical consumers; config loading and test discovery
          // stay with Vitest. Include-file overrides still intersect emitted filters.
          return matchesFile ? matchesFile(file, included, includePatterns) : included;
        }),
      )
      .map(({ mode }) => mode),
  );
}

export async function prepareVitestRuntime(
  selections: readonly VitestRuntimeTestSelection[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const mode = resolveVitestPretestBuildMode(selections);
  if (!mode) {
    return 0;
  }
  console.error(`[test] preparing ${mode} runtime before Vitest workers`);
  return runManagedCommand({
    bin: process.execPath,
    args: ["scripts/run-node.mjs", "--version"],
    cwd: path.resolve(import.meta.dirname, "../.."),
    env: { ...env, ...(mode === "private-qa" ? { OPENCLAW_BUILD_PRIVATE_QA: "1" } : {}) },
  });
}

export function isE2eBuildSkipped(env: NodeJS.ProcessEnv) {
  return env.OPENCLAW_E2E_SKIP_BUILD === "1" || env.OPENCLAW_E2E_USE_PREBUILT_DIST === "1";
}

export async function prepareE2eVitestRuntime(env: NodeJS.ProcessEnv) {
  if (isE2eBuildSkipped(env)) {
    return {};
  }
  console.error("[test] preparing E2E runtime before Vitest workers");
  await runE2eGlobalSetup(
    (args, commandEnv) =>
      runManagedCommand({ bin: process.execPath, args, cwd: process.cwd(), env: commandEnv }),
    env,
  );
  // Only successful preparation may tell readers to reuse this shared generation.
  return { OPENCLAW_E2E_USE_PREBUILT_DIST: "1" };
}

function runE2eSetupCommand(args: string[], env: NodeJS.ProcessEnv): Promise<number> {
  const child = spawn(process.execPath, args, {
    cwd: process.cwd(),
    detached: false,
    env,
    stdio: ["inherit", "pipe", "pipe"],
  });
  child.stdout.pipe(process.stdout, { end: false });
  child.stderr.pipe(process.stderr, { end: false });

  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (status, signal) => {
      if (signal) {
        reject(new Error(`E2E setup command terminated by ${signal}: ${args.join(" ")}`));
        return;
      }
      resolve(status ?? 1);
    });
  });
}

export async function runE2eGlobalSetup(
  runCommand: SetupCommandRunner = runE2eSetupCommand,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  // Focused suites may own their fixtures; prebuilt consumers already have the
  // complete surface. Neither may start another shared artifact writer.
  if (isE2eBuildSkipped(env)) {
    return;
  }
  const commands = [
    {
      args: ["scripts/run-node.mjs", "--version"],
      env: {
        ...env,
        OPENCLAW_BUILD_PRIVATE_QA: "1",
        OPENCLAW_RUN_NODE_SKIP_DTS_BUILD: "0",
      },
    },
    {
      args: ["--import", "tsx", "scripts/tsdown-build.mts", "--config", "tsdown.ai.config.ts"],
      env,
    },
  ];
  for (const { args, env: commandEnv } of commands) {
    const status = await runCommand(args, commandEnv);
    if (status !== 0) {
      throw new Error(`E2E setup command failed with exit code ${status}: ${args.join(" ")}`);
    }
  }
}

const require = createRequire(import.meta.url);

type VitestFs = {
  existsSync(path: string): boolean;
  symlinkSync?(target: string, path: string, type: "dir" | "junction"): void;
};
function isMissingVitestResolveError(error: unknown): error is NodeJS.ErrnoException {
  return (
    error instanceof Error &&
    "code" in error &&
    error.code === "MODULE_NOT_FOUND" &&
    error.message.includes("vitest/package.json")
  );
}

/**
 * Builds the actionable dependency-install message when Vitest is unavailable.
 */
export function resolveMissingVitestDependencyMessage(
  baseDir = resolveRepoRoot(import.meta.url),
  fsImpl: Pick<VitestFs, "existsSync"> = fs,
): string {
  const hasNodeModules = fsImpl.existsSync(path.join(baseDir, "node_modules"));
  const reason = hasNodeModules
    ? "[vitest] Vitest is not installed in node_modules."
    : "[vitest] node_modules is missing; Vitest cannot be resolved.";
  return [
    reason,
    "Install dependencies before running scripts/run-vitest.mjs:",
    "  pnpm install --frozen-lockfile",
    "For raw Crabbox/AWS macOS source syncs, hydrate or install dependencies before this runner.",
  ].join("\n");
}

function resolvePathFromBase(value: string, baseDir: string): string {
  return path.isAbsolute(value) ? value : path.resolve(baseDir, value);
}

function resolvePnpmModulesDir(env: NodeJS.ProcessEnv): string {
  return env.PNPM_CONFIG_MODULES_DIR?.trim() || env.npm_config_modules_dir?.trim() || "";
}

function resolveHydratedVitestPackageJson({
  baseDir,
  env,
  fsImpl,
}: {
  baseDir: string;
  env: NodeJS.ProcessEnv;
  fsImpl: Pick<VitestFs, "existsSync">;
}): string | null {
  const modulesDir = resolvePnpmModulesDir(env);
  if (!modulesDir) {
    return null;
  }
  const packageJsonPath = path.join(
    resolvePathFromBase(modulesDir, baseDir),
    "vitest",
    "package.json",
  );
  return fsImpl.existsSync(packageJsonPath) ? packageJsonPath : null;
}

function ensureHydratedNodeModulesSelfLink({
  hydratedNodeModulesPath,
  fsImpl,
  platform,
}: {
  hydratedNodeModulesPath: string;
  fsImpl: VitestFs;
  platform: NodeJS.Platform;
}): boolean {
  if (platform !== "win32") {
    return true;
  }
  const selfLinkPath = path.join(hydratedNodeModulesPath, "node_modules");
  if (fsImpl.existsSync(selfLinkPath)) {
    return true;
  }
  if (!fsImpl.symlinkSync) {
    return false;
  }
  try {
    fsImpl.symlinkSync(hydratedNodeModulesPath, selfLinkPath, "junction");
    return true;
  } catch {
    return false;
  }
}

function resolveHydratedVitestCliEntry({
  baseDir,
  env,
  fsImpl,
  platform,
}: {
  baseDir: string;
  env: NodeJS.ProcessEnv;
  fsImpl: VitestFs;
  platform: NodeJS.Platform;
}): string | null {
  const hydratedVitestPackageJson = resolveHydratedVitestPackageJson({ baseDir, env, fsImpl });
  if (!hydratedVitestPackageJson) {
    return null;
  }
  const hydratedNodeModulesPath = path.dirname(path.dirname(hydratedVitestPackageJson));
  if (!ensureHydratedNodeModulesSelfLink({ hydratedNodeModulesPath, fsImpl, platform })) {
    return null;
  }
  const nodeModulesPath = path.join(baseDir, "node_modules");
  if (fsImpl.existsSync(nodeModulesPath)) {
    const workspaceVitestCliEntry = path.join(nodeModulesPath, "vitest", "vitest.mjs");
    return fsImpl.existsSync(workspaceVitestCliEntry) ? workspaceVitestCliEntry : null;
  }
  if (!fsImpl.symlinkSync) {
    return null;
  }
  try {
    fsImpl.symlinkSync(
      hydratedNodeModulesPath,
      nodeModulesPath,
      platform === "win32" ? "junction" : "dir",
    );
  } catch {
    return null;
  }
  return path.join(nodeModulesPath, "vitest", "vitest.mjs");
}

/**
 * Resolves the Vitest CLI entry from normal or hydrated node_modules layouts.
 */
export function resolveVitestCliEntry({
  baseDir = resolveRepoRoot(import.meta.url),
  env = process.env,
  fsImpl = fs,
  platform = process.platform,
  requireResolve = require.resolve.bind(require),
}: {
  baseDir?: string;
  env?: NodeJS.ProcessEnv;
  fsImpl?: VitestFs;
  platform?: NodeJS.Platform;
  requireResolve?: (specifier: string, options?: { paths?: string[] }) => string;
} = {}): string {
  const hydratedVitestCliEntry = resolveHydratedVitestCliEntry({
    baseDir,
    env,
    fsImpl,
    platform,
  });
  if (hydratedVitestCliEntry) {
    return hydratedVitestCliEntry;
  }

  let vitestPackageJson: string;
  try {
    vitestPackageJson = requireResolve("vitest/package.json");
  } catch (error) {
    if (isMissingVitestResolveError(error)) {
      const wrappedError: NodeJS.ErrnoException = new Error(
        resolveMissingVitestDependencyMessage(baseDir, fsImpl),
      );
      wrappedError.code = "OPENCLAW_MISSING_VITEST";
      throw wrappedError;
    }
    throw error;
  }
  return path.join(path.dirname(vitestPackageJson), "vitest.mjs");
}
