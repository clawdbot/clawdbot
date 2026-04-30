import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { sanitizeTempPrefixSegment } from "./bundled-runtime-deps-stage-state.mjs";

const runtimeDepsStagingVersion = 7;

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function readOptionalUtf8(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  return fs.readFileSync(filePath, "utf8");
}

export function resolveLegacyRuntimeDepsStampPath(pluginDir) {
  return path.join(pluginDir, ".openclaw-runtime-deps-stamp.json");
}

export function resolveRuntimeDepsStampPath(repoRoot, pluginId) {
  return path.join(
    repoRoot,
    ".artifacts",
    "bundled-runtime-deps-stamps",
    `${sanitizeTempPrefixSegment(pluginId)}.json`,
  );
}

export function createRuntimeDepsFingerprint(packageJson, pruneConfig, params = {}) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        cheapFingerprint: createRuntimeDepsCheapFingerprint(packageJson, pruneConfig, params),
        rootInstalledRuntimeFingerprint: params.rootInstalledRuntimeFingerprint ?? null,
      }),
    )
    .digest("hex");
}

export function createRuntimeDepsCheapFingerprint(packageJson, pruneConfig, params = {}) {
  const repoRoot = params.repoRoot;
  const lockfilePath =
    typeof repoRoot === "string" && repoRoot.length > 0
      ? path.join(repoRoot, "pnpm-lock.yaml")
      : null;
  const rootLockfile = lockfilePath ? readOptionalUtf8(lockfilePath) : null;
  return createHash("sha256")
    .update(
      JSON.stringify({
        globalPruneDirectories: pruneConfig.globalPruneDirectories,
        globalPruneFilePatterns: pruneConfig.globalPruneFilePatterns.map((pattern) =>
          pattern.toString(),
        ),
        globalPruneSuffixes: pruneConfig.globalPruneSuffixes,
        packageJson,
        pruneRules: [...pruneConfig.pruneRules.entries()],
        rootLockfile,
        version: runtimeDepsStagingVersion,
      }),
    )
    .digest("hex");
}

export function readRuntimeDepsStamp(stampPath) {
  if (!fs.existsSync(stampPath)) {
    return null;
  }
  try {
    return readJson(stampPath);
  } catch {
    return null;
  }
}
