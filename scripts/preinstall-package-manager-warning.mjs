// Enforces the package runtime contract, then warns for non-pnpm lifecycle installs.
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { posix, win32 } from "node:path";
import { pathToFileURL } from "node:url";

const allowedLifecyclePackageManagers = new Set(["pnpm", "npm", "yarn", "bun"]);
const lifecyclePackageManagerLauncherAliases = new Map([
  ["yarnpkg", "yarn"],
  ["yarn-berry", "yarn"],
]);
const NODE_ENGINE_CLAUSE_RE = /^\s*>=\s*v?(\d+\.\d+\.\d+)(?:\s+<\s*v?(\d+(?:\.\d+\.\d+)?))?\s*$/iu;
const NODE_VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const NODE_RUNTIME_PROBE_SOURCE =
  "process.stdout.write(JSON.stringify({version:process.versions.node??null,bunVersion:process.versions.bun??null,execPath:process.execPath??null}))";
const PACKAGE_CLI_NODE_PROBE_TIMEOUT_MS = 10_000;
export const PACKAGE_INSTALL_GUARD_RELATIVE_PATH = "dist/openclaw-install-guard";

function normalizeEnvValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

function parseNodeVersion(value) {
  const match = NODE_VERSION_RE.exec(normalizeEnvValue(value));
  if (!match) {
    return null;
  }
  return {
    major: Number.parseInt(match[1] ?? "", 10),
    minor: Number.parseInt(match[2] ?? "", 10),
    patch: Number.parseInt(match[3] ?? "", 10),
  };
}

function isNodeVersionAtLeast(version, minimum) {
  if (version.major !== minimum.major) {
    return version.major > minimum.major;
  }
  if (version.minor !== minimum.minor) {
    return version.minor > minimum.minor;
  }
  return version.patch >= minimum.patch;
}

/** Checks a Node version against the standalone package engine-range subset. */
export function nodeVersionSatisfiesPackageEngine(version, engine) {
  const parsedVersion = parseNodeVersion(version);
  const normalizedEngine = normalizeEnvValue(engine);
  if (!parsedVersion || !normalizedEngine) {
    return false;
  }

  let satisfied = false;
  for (const clause of normalizedEngine.split("||")) {
    const match = NODE_ENGINE_CLAUSE_RE.exec(clause);
    if (!match) {
      return false;
    }
    const minimum = parseNodeVersion(match[1]);
    const upperRaw = match[2];
    const upper = upperRaw
      ? parseNodeVersion(upperRaw.includes(".") ? upperRaw : `${upperRaw}.0.0`)
      : null;
    if (!minimum || (upperRaw && !upper)) {
      return false;
    }
    if (
      isNodeVersionAtLeast(parsedVersion, minimum) &&
      (!upper || !isNodeVersionAtLeast(parsedVersion, upper))
    ) {
      satisfied = true;
    }
  }
  return satisfied;
}

/** Reads the Node runtime contract from the package being installed. */
export function readPackageNodeEngine(
  packageJsonUrl = new URL("../package.json", import.meta.url),
) {
  try {
    const manifest = JSON.parse(readFileSync(packageJsonUrl, "utf8"));
    return normalizeEnvValue(manifest?.engines?.node) || null;
  } catch {
    return null;
  }
}

function parseNodeRuntimeProbeOutput(value) {
  try {
    const parsed = JSON.parse(normalizeEnvValue(value));
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    return {
      version: normalizeEnvValue(parsed.version) || null,
      bunVersion: normalizeEnvValue(parsed.bunVersion) || null,
      execPath: normalizeEnvValue(parsed.execPath) || null,
    };
  } catch {
    return null;
  }
}

function normalizePathForComparison(value, pathApi, platform) {
  const normalized = pathApi.normalize(value);
  return platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isStableAbsolutePath(value, pathApi, platform) {
  if (!pathApi.isAbsolute(value)) {
    return false;
  }
  if (platform !== "win32") {
    return true;
  }
  const root = pathApi.parse(value).root;
  return root !== "\\" && root !== "/";
}

function stripBunLifecyclePathPrefix(pathEntries, cwd, pathApi, platform) {
  const expectedPrefix = [];
  let directory = pathApi.resolve(cwd);
  while (true) {
    expectedPrefix.push(pathApi.join(directory, "node_modules", ".bin"));
    const parent = pathApi.dirname(directory);
    if (parent === directory) {
      break;
    }
    directory = parent;
  }

  if (pathEntries.length < expectedPrefix.length) {
    return null;
  }
  for (const [index, expected] of expectedPrefix.entries()) {
    if (
      normalizePathForComparison(pathEntries[index], pathApi, platform) !==
      normalizePathForComparison(expected, pathApi, platform)
    ) {
      return null;
    }
  }
  return pathEntries.slice(expectedPrefix.length);
}

/** Finds the real Node that will launch the installed CLI after Bun removes its lifecycle PATH. */
export function probePackageCliNodeRuntime(options = {}) {
  const {
    env = process.env,
    pathEnv = env.PATH ?? "",
    platform = process.platform,
    cwd = process.cwd(),
    run = spawnSync,
  } = options;
  const pathApi = platform === "win32" ? win32 : posix;
  const delimiter = platform === "win32" ? ";" : ":";
  const executableName = platform === "win32" ? "node.exe" : "node";
  const seen = new Set();
  // Bun prepends one cwd-to-root node_modules/.bin path per ancestor before
  // the original PATH. Strip only that exact prefix; anything else persists.
  const pathEntries = stripBunLifecyclePathPrefix(pathEnv.split(delimiter), cwd, pathApi, platform);
  if (!pathEntries) {
    return null;
  }

  for (const entry of pathEntries) {
    if (!entry || !isStableAbsolutePath(entry, pathApi, platform)) {
      // Relative paths, including Windows root-relative paths, resolve against
      // each future CLI invocation's cwd or drive.
      // No preinstall probe can safely approve the Node they may select later.
      return null;
    }
    const candidate = pathApi.join(entry, executableName);
    if (seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);

    const childEnv = { ...env };
    for (const key of Object.keys(childEnv)) {
      if (key.toUpperCase() === "NODE_OPTIONS") {
        delete childEnv[key];
      }
    }
    const result = run(candidate, ["-e", NODE_RUNTIME_PROBE_SOURCE], {
      cwd,
      encoding: "utf8",
      env: childEnv,
      timeout: PACKAGE_CLI_NODE_PROBE_TIMEOUT_MS,
      windowsHide: true,
    });
    if (
      result?.error?.code === "EACCES" ||
      result?.error?.code === "ENOENT" ||
      result?.error?.code === "ENOTDIR"
    ) {
      continue;
    }
    if (result?.status !== 0) {
      return null;
    }

    const runtime = parseNodeRuntimeProbeOutput(result.stdout);
    if (!runtime) {
      return null;
    }
    // A Bun-backed candidate from the original PATH remains first after install.
    // It cannot satisfy the package's Node engine contract, so fail closed.
    if (runtime.bunVersion) {
      return null;
    }
    return runtime;
  }

  return null;
}

/** Rejects installation before an unsupported runtime can replace a working release. */
export function enforceSupportedNodeRuntime(
  {
    version = process.versions.node ?? null,
    bunVersion = process.versions.bun ?? null,
    engine = readPackageNodeEngine(),
    execPath = process.execPath,
    probeNodeRuntime = probePackageCliNodeRuntime,
  } = {},
  reportError = console.error,
) {
  const detectedRuntime = normalizeEnvValue(bunVersion)
    ? probeNodeRuntime()
    : { version, execPath };
  if (nodeVersionSatisfiesPackageEngine(detectedRuntime?.version ?? null, engine)) {
    return true;
  }

  const requirement = engine
    ? `this OpenClaw release requires Node ${engine}.`
    : "could not read this OpenClaw release's Node requirement.";
  reportError(
    [
      `[openclaw] error: ${requirement}`,
      `[openclaw] detected Node ${detectedRuntime?.version ?? "missing"} (exec: ${detectedRuntime?.execPath || "unknown"}).`,
      "[openclaw] install Node: https://nodejs.org/en/download",
      "[openclaw] upgrade Node, then retry the OpenClaw update.",
    ].join("\n"),
  );
  return false;
}

/** Removes the packed sentinel only after the runtime check succeeds. */
export function completePackageInstallGuard(
  {
    markerUrl = new URL(`../${PACKAGE_INSTALL_GUARD_RELATIVE_PATH}`, import.meta.url),
    remove = rmSync,
  } = {},
  reportError = console.error,
) {
  try {
    remove(markerUrl, { force: true });
    return true;
  } catch (error) {
    reportError(
      `[openclaw] error: could not complete package preinstall: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return false;
  }
}

function normalizeLifecyclePackageManagerName(value) {
  const normalized = normalizeEnvValue(value).toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]*$/u.test(normalized)) {
    return null;
  }
  return allowedLifecyclePackageManagers.has(normalized) ? normalized : null;
}

function detectLifecyclePackageManagerFromExecPath(value) {
  const execPath = normalizeEnvValue(value).toLowerCase();
  const executableName = execPath.split(/[\\/]/u).findLast((segment) => segment.length > 0) ?? "";
  const launcherName = executableName.replace(/\.(?:c?js|mjs|cmd|ps1|exe)$/u, "");
  const candidates = [launcherName, launcherName.replace(/-cli$/u, "")];

  for (const candidate of candidates) {
    if (/^yarn(?:pkg)?-\d/u.test(candidate)) {
      return "yarn";
    }

    const aliasedPackageManager = lifecyclePackageManagerLauncherAliases.get(candidate);
    if (aliasedPackageManager) {
      return aliasedPackageManager;
    }

    const packageManager = normalizeLifecyclePackageManagerName(candidate);
    if (packageManager) {
      return packageManager;
    }
  }

  return null;
}

/**
 * Detects the package manager running the current lifecycle script.
 */
export function detectLifecyclePackageManager(env = process.env) {
  const userAgent = normalizeEnvValue(env.npm_config_user_agent);
  const userAgentMatch = /^([A-Za-z0-9._-]+)\//u.exec(userAgent);
  if (userAgentMatch) {
    return normalizeLifecyclePackageManagerName(userAgentMatch[1]);
  }

  return detectLifecyclePackageManagerFromExecPath(env.npm_execpath);
}

/**
 * Builds the warning shown for non-pnpm lifecycle installs.
 */
export function createPackageManagerWarningMessage(packageManager) {
  if (!packageManager || packageManager === "pnpm") {
    return null;
  }

  return [
    `[openclaw] warning: detected ${packageManager} for install lifecycle.`,
    "[openclaw] this repo works best with pnpm; npm-compatible installs are slower and much larger here.",
    "[openclaw] prefer: corepack pnpm install",
  ].join("\n");
}

/**
 * Emits the non-pnpm lifecycle warning when needed.
 */
export function warnIfNonPnpmLifecycle(env = process.env, warn = console.warn) {
  const message = createPackageManagerWarningMessage(detectLifecyclePackageManager(env));
  if (!message) {
    return false;
  }
  warn(message);
  return true;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  if (enforceSupportedNodeRuntime() && completePackageInstallGuard()) {
    warnIfNonPnpmLifecycle();
  } else {
    process.exitCode = 1;
  }
}
