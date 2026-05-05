import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  acquireLocalHeavyCheckLockSync,
  applyLocalOxlintPolicy,
  resolveLocalHeavyCheckEnv,
  shouldAcquireLocalHeavyCheckLockForOxlint,
} from "./lib/local-heavy-check-runtime.mjs";
import { runManagedCommand } from "./lib/managed-child-process.mjs";

const oxlintPath = path.resolve("node_modules", ".bin", "oxlint");
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

export function shouldPrepareExtensionPackageBoundaryArtifacts(args) {
  return !args.some((arg) => OXLINT_PREPARE_SKIP_FLAGS.has(arg));
}

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
  const result = spawnSync("git", ["config", "--get", "--bool", "core.sparseCheckout"], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32",
  });

  return result.status === 0 && result.stdout.trim() === "true";
}

function hasTrackedPath({ cwd, target }) {
  const result = spawnSync("git", ["ls-files", "--", target], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32",
  });

  return result.status === 0 && result.stdout.trim().length > 0;
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

export async function main(argv = process.argv.slice(2), runtimeEnv = process.env) {
  const { args: policyArgs, env } = applyLocalOxlintPolicy(
    argv,
    resolveLocalHeavyCheckEnv(runtimeEnv),
  );
  const sparseTargets = filterSparseMissingOxlintTargets(policyArgs);
  const finalArgs = sparseTargets.args;
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
    env.OPENCLAW_OXLINT_SKIP_LOCK === "1"
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
    if (
      env.OPENCLAW_OXLINT_SKIP_PREPARE !== "1" &&
      shouldPrepareExtensionPackageBoundaryArtifacts(finalArgs)
    ) {
      await prepareExtensionPackageBoundaryArtifacts(env);
    }

    const status = await runManagedCommand({
      bin: oxlintPath,
      args: finalArgs,
      env,
    });
    process.exitCode = status;
  } finally {
    releaseLock();
  }
}

if (import.meta.main) {
  await main();
}
