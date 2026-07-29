// Runs oxlint with local heavy-check policy, sparse-checkout filtering, and
// plugin package-boundary artifact preparation when needed.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  acquireLocalHeavyCheckLockSync,
  applyLocalOxlintPolicy,
  resolveLocalHeavyCheckEnv,
  resolveRepoToolBinPath,
  shouldAcquireLocalHeavyCheckLockForOxlint,
} from "./lib/local-heavy-check-runtime.mjs";
import { createManagedCommandInvocation, runManagedCommand } from "./lib/managed-child-process.mjs";
import { resolvePathEnvKey } from "./windows-cmd-helpers.mjs";

const PREPARE_EXTENSION_BOUNDARY_ARGS = [
  path.resolve("scripts", "prepare-extension-package-boundary-artifacts.mjs"),
];
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
const OPENCLAW_FOCUSED_CONFIG_FLAG = "--openclaw-focused-config";

/**
 * Returns whether oxlint args need package-boundary declaration artifacts first.
 */
export function shouldPrepareExtensionPackageBoundaryArtifacts(args) {
  return !args.some((arg) => OXLINT_PREPARE_SKIP_FLAGS.has(arg));
}

/**
 * Drops tracked-but-missing sparse-checkout targets so narrow sparse checks can pass.
 */
export function filterSparseMissingOxlintTargets(
  args,
  {
    cwd = process.cwd(),
    fileExists = fs.existsSync,
    isSparseCheckoutEnabled = getSparseCheckoutEnabled,
    isTrackedPath = hasTrackedPath,
  } = {},
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

function getSparseCheckoutEnabled({ cwd }) {
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

function hasTrackedPath({ cwd, target }) {
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

function resolveOxlintToolchainEnv(oxlintPath, env, platform = process.platform) {
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

async function prepareExtensionPackageBoundaryArtifacts(env) {
  const releaseArtifactsLock = acquireLocalHeavyCheckLockSync({
    cwd: process.cwd(),
    env,
    toolName: "extension-package-boundary-artifacts",
    lockName: "extension-package-boundary-artifacts",
  });

  try {
    const status = await runManagedCommand({
      bin: process.execPath,
      args: PREPARE_EXTENSION_BOUNDARY_ARGS,
      env,
    });

    if (status !== 0) {
      throw new Error(
        `prepare-extension-package-boundary-artifacts failed with exit code ${status}`,
      );
    }
  } finally {
    releaseArtifactsLock();
  }
}

/**
 * Applies wrapper policy and runs oxlint with the final argument list.
 */
export async function main(argv = process.argv.slice(2), runtimeEnv = process.env) {
  const focusedConfig = argv.includes(OPENCLAW_FOCUSED_CONFIG_FLAG);
  const oxlintArgs = argv.filter((arg) => arg !== OPENCLAW_FOCUSED_CONFIG_FLAG);
  const localEnv = resolveLocalHeavyCheckEnv(runtimeEnv);
  // Focused configs are syntax-only guards; keep wrapper process handling
  // without the broad type-aware policy or package artifact preparation.
  const { args: policyArgs, env } = focusedConfig
    ? { args: oxlintArgs, env: localEnv }
    : applyLocalOxlintPolicy(oxlintArgs, localEnv);
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
    return;
  }
  if (sparseTargets.hadExplicitTargets && sparseTargets.remainingExplicitTargets === 0) {
    console.error("[oxlint] no present sparse-checkout targets remain; skipping oxlint.");
    return;
  }

  const releaseLock =
    env.OPENCLAW_OXLINT_SKIP_LOCK === "1" || focusedConfig
      ? () => {}
      : shouldAcquireLocalHeavyCheckLockForOxlint(finalArgs, {
            cwd: process.cwd(),
            env,
          })
        ? acquireLocalHeavyCheckLockSync({
            cwd: process.cwd(),
            env,
            toolName: "oxlint",
          })
        : () => {};

  try {
    if (needsArtifactPreparation) {
      await prepareExtensionPackageBoundaryArtifacts(env);
    }

    const status = await runManagedCommand({
      bin: oxlintPath,
      args: finalArgs,
      env: resolveOxlintToolchainEnv(oxlintPath, env),
    });
    process.exitCode = status;
  } finally {
    releaseLock();
  }
}

/**
 * CLI entry: converts wrapper crashes into a nonzero exit and ends every
 * failing run with one stable final line. That line must survive output
 * truncation (`… | tail -N`): without it, a crash or lint failure whose
 * diagnostics scrolled away reads as success when only the tail is inspected.
 */
export async function runOxlintCliEntry(run = main, log = console.error) {
  try {
    await run();
  } catch (error) {
    log(error);
    process.exitCode = 1;
  }
  if (typeof process.exitCode === "number" && process.exitCode !== 0) {
    log(`[oxlint] FAILED (exit ${process.exitCode})`);
  }
}

if (import.meta.main) {
  await runOxlintCliEntry();
}
