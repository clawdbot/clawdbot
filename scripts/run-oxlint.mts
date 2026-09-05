// Runs oxlint with local resource policy, sparse-checkout filtering, and
// plugin package-boundary artifact preparation when needed.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isDirectRunUrl } from "./lib/direct-run.mjs";
import {
  distArtifactEntryArgs,
  withDistArtifactOwnership,
} from "./lib/dist-artifact-ownership.mts";
import {
  applyLocalOxlintPolicy,
  resolveLocalCheckEnv,
  resolveRepoToolBinPath,
} from "./lib/local-check-runtime.mts";
import { createManagedCommandInvocation, runManagedCommand } from "./lib/managed-child-process.mts";
import { resolvePathEnvKey } from "./windows-cmd-helpers.mjs";

const PREPARE_EXTENSION_BOUNDARY_ARGS = distArtifactEntryArgs(
  path.resolve("scripts", "prepare-extension-package-boundary-artifacts.mts"),
  ["--mode=package-boundary"],
);
const OXLINT_PREPARE_SKIP_FLAGS = new Set([
  "--help",
  "-h",
  "--version",
  "-V",
  "--print-config",
  "--rules",
  "--init",
  "--lsp",
]);
const OXLINT_VALUE_FLAGS = new Set([
  "--config",
  "--deny",
  "--env",
  "--format",
  "--globals",
  "--ignore-path",
  "--max-warnings",
  "--output-file",
  "--plugin",
  "--rules",
  "--tsconfig",
  "--warn",
]);
const OXLINT_BOUNDARY_FREE_TS_CONFIGS = new Set([
  "config/tsconfig/oxlint.core.json",
  "config/tsconfig/oxlint.scripts.json",
  "test/tsconfig/tsconfig.test.root.json",
]);
const OPENCLAW_FOCUSED_CONFIG_FLAG = "--openclaw-focused-config";

/**
 * Returns whether oxlint args need package-boundary declaration artifacts first.
 */
export function shouldPrepareExtensionPackageBoundaryArtifacts(args: string[]) {
  if (args.some((arg) => OXLINT_PREPARE_SKIP_FLAGS.has(arg))) {
    return false;
  }

  const tsconfigs = args.flatMap((arg, index) => {
    if (arg === "--tsconfig") {
      const value = args[index + 1];
      return value === undefined ? [] : [value];
    }
    return arg.startsWith("--tsconfig=") ? [arg.slice("--tsconfig=".length)] : [];
  });
  // Core, script, and root-test lint resolve sources through the root tsconfig;
  // generated plugin package declarations are only an extension-lint input.
  return (
    tsconfigs.length === 0 ||
    tsconfigs.some((tsconfig) => !OXLINT_BOUNDARY_FREE_TS_CONFIGS.has(tsconfig))
  );
}

/**
 * Drops tracked-but-missing sparse-checkout targets so narrow sparse checks can pass.
 */
export function filterSparseMissingOxlintTargets(
  args: string[],
  {
    cwd = process.cwd(),
    fileExists = fs.existsSync,
    isSparseCheckoutEnabled = getSparseCheckoutEnabled,
    isTrackedPath = hasTrackedPath,
  }: Partial<{
    cwd?: string;
    fileExists?: (target: string) => boolean;
    isSparseCheckoutEnabled?: (params: { cwd: string }) => boolean;
    isTrackedPath?: (params: { cwd: string; target: string }) => boolean;
  }> = {},
) {
  if (!isSparseCheckoutEnabled({ cwd })) {
    return {
      args,
      hadExplicitTargets: false,
      remainingExplicitTargets: 0,
      skippedTargets: [],
      skippedConfigs: [],
    };
  }

  const filteredArgs = [];
  const skippedTargets = [];
  const skippedConfigs = [];
  let hadExplicitTargets = false;
  let remainingExplicitTargets = 0;
  let consumeNextValue = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) {
      continue;
    }
    if (consumeNextValue) {
      filteredArgs.push(arg);
      consumeNextValue = false;
      continue;
    }

    if (arg === "--") {
      filteredArgs.push(arg);
      continue;
    }

    if (arg.startsWith("--")) {
      if (arg === "--tsconfig") {
        const value = args[index + 1];
        if (value !== undefined) {
          index += 1;
          if (!fileExists(path.resolve(cwd, value)) && isTrackedPath({ cwd, target: value })) {
            skippedConfigs.push(value);
            continue;
          }
          filteredArgs.push(arg, value);
          continue;
        }
      }
      if (arg.startsWith("--tsconfig=")) {
        const value = arg.slice("--tsconfig=".length);
        if (
          value &&
          !fileExists(path.resolve(cwd, value)) &&
          isTrackedPath({ cwd, target: value })
        ) {
          skippedConfigs.push(value);
          continue;
        }
      }
      filteredArgs.push(arg);
      if (!arg.includes("=") && OXLINT_VALUE_FLAGS.has(arg)) {
        consumeNextValue = true;
      }
      continue;
    }

    if (arg.startsWith("-")) {
      filteredArgs.push(arg);
      continue;
    }

    hadExplicitTargets = true;
    const absoluteTarget = path.resolve(cwd, arg);
    if (!fileExists(absoluteTarget) && isTrackedPath({ cwd, target: arg })) {
      skippedTargets.push(arg);
      continue;
    }

    remainingExplicitTargets += 1;
    filteredArgs.push(arg);
  }

  return {
    args: filteredArgs,
    hadExplicitTargets,
    remainingExplicitTargets,
    skippedTargets,
    skippedConfigs,
  };
}

function getSparseCheckoutEnabled({ cwd }: { cwd: string }) {
  const git = createManagedCommandInvocation({
    args: ["config", "--get", "--bool", "core.sparseCheckout"],
    bin: "git",
  });
  const result = spawnSync(git.command, git.args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    shell: git.shell,
    windowsVerbatimArguments: git.windowsVerbatimArguments,
  });

  return result.status === 0 && result.stdout.trim() === "true";
}

function hasTrackedPath({ cwd, target }: { cwd: string; target: string }) {
  const git = createManagedCommandInvocation({
    args: ["ls-files", "--", target],
    bin: "git",
  });
  const result = spawnSync(git.command, git.args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    shell: git.shell,
    windowsVerbatimArguments: git.windowsVerbatimArguments,
  });

  return result.status === 0 && result.stdout.trim().length > 0;
}

function resolveOxlintToolchainEnv(
  oxlintPath: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
) {
  const pathKey = platform === "win32" ? resolvePathEnvKey(env) : "PATH";
  const delimiter = platform === "win32" ? ";" : path.delimiter;
  const currentPath = env[pathKey]?.trim();
  return {
    ...env,
    // Type-aware oxlint resolves its optional tsgolint peer through PATH, so
    // keep the selected checkout's toolchain together in dependency-less worktrees.
    [pathKey]: [path.dirname(oxlintPath), currentPath].filter(Boolean).join(delimiter),
  };
}

async function prepareExtensionPackageBoundaryArtifacts(env: NodeJS.ProcessEnv) {
  const status = await runManagedCommand({
    bin: process.execPath,
    args: PREPARE_EXTENSION_BOUNDARY_ARGS,
    env,
    requireProcessTreeExit: process.platform !== "win32",
  });

  if (status !== 0) {
    throw new Error(`prepare-extension-package-boundary-artifacts failed with exit code ${status}`);
  }
}

/**
 * Applies wrapper policy and runs oxlint with the final argument list.
 */
async function runOxlint(
  argv: string[] = process.argv.slice(2),
  runtimeEnv: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const focusedConfig = argv.includes(OPENCLAW_FOCUSED_CONFIG_FLAG);
  const oxlintArgs = argv.filter((arg) => arg !== OPENCLAW_FOCUSED_CONFIG_FLAG);
  const localEnv = resolveLocalCheckEnv(runtimeEnv);
  // Focused configs are syntax-only guards; keep wrapper process handling
  // without the broad type-aware policy or package artifact preparation.
  const { args: policyArgs, env } = focusedConfig
    ? { args: oxlintArgs, env: localEnv }
    : applyLocalOxlintPolicy(oxlintArgs, localEnv, {
        logicalCpuCount: os.availableParallelism(),
        totalMemoryBytes: os.totalmem(),
      });
  const sparseTargets = filterSparseMissingOxlintTargets(policyArgs);
  const finalArgs = sparseTargets.args;
  const oxlintPath = resolveRepoToolBinPath("oxlint");
  const needsArtifactPreparation =
    !focusedConfig &&
    env.OPENCLAW_OXLINT_SKIP_PREPARE !== "1" &&
    shouldPrepareExtensionPackageBoundaryArtifacts(finalArgs);
  if (sparseTargets.skippedTargets.length > 0) {
    console.error(
      `[oxlint] sparse checkout is missing tracked target(s); skipping ${sparseTargets.skippedTargets.join(", ")}`,
    );
  }
  if (sparseTargets.skippedConfigs.length > 0) {
    console.error(
      `[oxlint] sparse checkout is missing tracked config(s); skipping oxlint: ${sparseTargets.skippedConfigs.join(", ")}`,
    );
    return 0;
  }
  if (sparseTargets.hadExplicitTargets && sparseTargets.remainingExplicitTargets === 0) {
    console.error("[oxlint] no present sparse-checkout targets remain; skipping oxlint.");
    return 0;
  }

  if (needsArtifactPreparation) {
    // Declaration compilation owns its Go policy; lint limits belong to the oxlint child.
    await prepareExtensionPackageBoundaryArtifacts(localEnv);
  }
  return await runManagedCommand({
    bin: oxlintPath,
    args: finalArgs,
    env: resolveOxlintToolchainEnv(oxlintPath, env),
    requireProcessTreeExit: process.platform !== "win32",
  });
}

if (isDirectRunUrl(process.argv[1], import.meta.url)) {
  const argv = process.argv.slice(2);
  // Skip-prepare callers still consume shared declarations. Source-only lint
  // remains independent; sharded lint inherits its parent's owner.
  process.exitCode =
    !argv.includes(OPENCLAW_FOCUSED_CONFIG_FLAG) &&
    shouldPrepareExtensionPackageBoundaryArtifacts(argv)
      ? await withDistArtifactOwnership(process.cwd(), () => runOxlint(argv))
      : await runOxlint(argv);
}
