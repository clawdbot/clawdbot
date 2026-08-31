// Resolves changed bundled extension ids from git diff paths.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { BUNDLED_PLUGIN_PATH_PREFIX, BUNDLED_PLUGIN_ROOT_DIR } from "./bundled-plugin-paths.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");

type ChangedPathsBaseParams = Partial<Record<"base" | "fallbackBaseRef" | "head", string>>;
type ChangedExtensionParams = Partial<Record<"base" | "cwd" | "head", string>> & {
  unavailableBaseBehavior?: "all" | "empty" | "error";
};

function runGit(args: string[]) {
  return execFileSync("git", args, {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
}

function normalizeRelative(inputPath: string) {
  return inputPath.split(path.sep).join("/");
}

function hasGitCommit(ref: string | undefined) {
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

function resolveChangedPathsBase(params: ChangedPathsBaseParams = {}) {
  const base = params.base;
  const head = params.head ?? "HEAD";
  const fallbackBaseRef = params.fallbackBaseRef;

  if (base && hasGitCommit(base)) {
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

function listChangedPaths(base: string, head = "HEAD") {
  if (!base) {
    throw new Error("A git base revision is required to list changed extensions.");
  }

  return runGit(["diff", "--name-only", base, head])
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function listAvailableExtensionIdsFromGit() {
  const packageFiles = runGit([
    "ls-files",
    "--",
    `:(glob)${BUNDLED_PLUGIN_PATH_PREFIX}*/package.json`,
  ])
    .split("\n")
    .map((line) => normalizeRelative(line.trim()))
    .filter((line) => line.length > 0);
  return packageFiles
    .flatMap((file) => {
      const match = file.match(new RegExp(`^${BUNDLED_PLUGIN_PATH_PREFIX}([^/]+)/package\\.json$`));
      return match?.[1] ? [match[1]] : [];
    })
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

/** List bundled extension ids available in git or the local extensions directory. */
export function listAvailableExtensionIds() {
  try {
    return listAvailableExtensionIdsFromGit();
  } catch {
    return listAvailableExtensionIdsFromDirectory();
  }
}

/** Map changed paths to bundled extension ids, ignoring unknown extension-like paths. */
export function detectChangedExtensionIds(changedPaths: string[]) {
  const availableExtensionIds = new Set(listAvailableExtensionIds());
  const extensionIds = new Set<string>();

  for (const rawPath of changedPaths) {
    const relativePath = normalizeRelative(rawPath.trim());
    if (!relativePath) {
      continue;
    }

    const extensionMatch = relativePath.match(
      new RegExp(`^${BUNDLED_PLUGIN_PATH_PREFIX.replace("/", "\\/")}([^/]+)(?:/|$)`),
    );
    if (extensionMatch) {
      const extensionId = extensionMatch[1];
      if (extensionId && availableExtensionIds.has(extensionId)) {
        extensionIds.add(extensionId);
      }
      continue;
    }

    const pairedCoreMatch = relativePath.match(/^src\/([^/]+)(?:\/|$)/);
    const pairedExtensionId = pairedCoreMatch?.[1];
    if (pairedExtensionId && availableExtensionIds.has(pairedExtensionId)) {
      extensionIds.add(pairedExtensionId);
    }
  }

  return [...extensionIds].toSorted((left, right) => left.localeCompare(right));
}

/** List changed bundled extension ids between a resolved base and head revision. */
export function listChangedExtensionIds(params: ChangedExtensionParams = {}) {
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
