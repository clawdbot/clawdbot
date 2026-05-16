import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { BUNDLED_PLUGIN_PATH_PREFIX, BUNDLED_PLUGIN_ROOT_DIR } from "./bundled-plugin-paths.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");

function runGit(args, options = {}) {
  return execFileSync("git", args, {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    ...options,
  });
}

function normalizeRelative(inputPath) {
  return inputPath.split(path.sep).join("/");
}

function hasGitCommit(ref) {
  if (!ref || /^0+$/.test(ref)) {
    return false;
  }

  try {
    runGit(["rev-parse", "--verify", `${ref}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

function resolveChangedPathsBase(params = {}) {
  const base = params.base;
  const head = params.head ?? "HEAD";
  const fallbackBaseRef = params.fallbackBaseRef;

  if (hasGitCommit(base)) {
    return base;
  }

  if (fallbackBaseRef) {
    const remoteBaseRef = fallbackBaseRef.startsWith("origin/")
      ? fallbackBaseRef
      : `origin/${fallbackBaseRef}`;
    if (hasGitCommit(remoteBaseRef)) {
      const mergeBase = runGit(["merge-base", remoteBaseRef, head]).trim();
      if (hasGitCommit(mergeBase)) {
        return mergeBase;
      }
    }
  }

  if (!base) {
    throw new Error("A git base revision is required to list changed extensions.");
  }

  throw new Error(`Git base revision is unavailable locally: ${base}`);
}

function listChangedPaths(base, head = "HEAD") {
  if (!base) {
    throw new Error("A git base revision is required to list changed extensions.");
  }

  return runGit(["diff", "--name-only", base, head])
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function listAvailableExtensionIdsFromGit() {
  const packageFiles = runGit(["ls-files", "--", `:(glob)${BUNDLED_PLUGIN_PATH_PREFIX}*/package.json`])
    .split("\n")
    .map((line) => normalizeRelative(line.trim()))
    .filter((line) => line.length > 0);
  return packageFiles
    .map((file) => file.match(new RegExp(`^${BUNDLED_PLUGIN_PATH_PREFIX}([^/]+)/package\\.json$`)))
    .filter((match) => match)
    .map((match) => match[1])
    .toSorted((left, right) => left.localeCompare(right));
}

function listAvailableExtensionIdsFromDirectory() {
  const extensionsDir = path.join(repoRoot, BUNDLED_PLUGIN_ROOT_DIR);
  if (!fs.existsSync(extensionsDir)) {
    return [];
  }

  return fs
    .readdirSync(extensionsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((extensionId) =>
      fs.existsSync(path.join(repoRoot, BUNDLED_PLUGIN_ROOT_DIR, extensionId, "package.json")),
    )
    .toSorted((left, right) => left.localeCompare(right));
}

export function listAvailableExtensionIds() {
  try {
    return listAvailableExtensionIdsFromGit();
  } catch {
    return listAvailableExtensionIdsFromDirectory();
  }
}

export function detectChangedExtensionIds(changedPaths) {
  const availableExtensionIds = new Set(listAvailableExtensionIds());
  const extensionIds = new Set();

  for (const rawPath of changedPaths) {
    const relativePath = normalizeRelative(String(rawPath).trim());
    if (!relativePath) {
      continue;
    }

    const extensionMatch = relativePath.match(
      new RegExp(`^${BUNDLED_PLUGIN_PATH_PREFIX.replace("/", "\\/")}([^/]+)(?:/|$)`),
    );
    if (extensionMatch) {
      const extensionId = extensionMatch[1];
      if (availableExtensionIds.has(extensionId)) {
        extensionIds.add(extensionId);
      }
      continue;
    }

    const pairedCoreMatch = relativePath.match(/^src\/([^/]+)(?:\/|$)/);
    if (pairedCoreMatch && availableExtensionIds.has(pairedCoreMatch[1])) {
      extensionIds.add(pairedCoreMatch[1]);
    }
  }

  return [...extensionIds].toSorted((left, right) => left.localeCompare(right));
}

export function listChangedExtensionIds(params = {}) {
  const head = params.head ?? "HEAD";
  const unavailableBaseBehavior = params.unavailableBaseBehavior ?? "error";

  try {
    const base = resolveChangedPathsBase(params);
    return detectChangedExtensionIds(listChangedPaths(base, head));
  } catch (error) {
    if (unavailableBaseBehavior === "all") {
      return listAvailableExtensionIds();
    }
    if (unavailableBaseBehavior === "empty") {
      return [];
    }
    throw error;
  }
}
