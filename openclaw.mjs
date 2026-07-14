#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { access } from "node:fs/promises";
import module from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MIN_NODE_22 = { major: 22, minor: 22, patch: 3 };
const MIN_NODE_24 = { major: 24, minor: 15, patch: 0 };
const MIN_NODE_25 = { major: 25, minor: 9, patch: 0 };
const RECOMMENDED_NODE_MAJOR = 24;
const SUPPORTED_NODE_RANGE = ">=22.22.3 <23, >=24.15.0 <25, or >=25.9.0";
const COMPILE_CACHE_DISABLED_RESPAWNED_ENV = "OPENCLAW_COMPILE_CACHE_DISABLED_RESPAWNED";

const parseNodeVersion = (rawVersion) => {
  const [majorRaw = "0", minorRaw = "0", patchRaw = "0"] = rawVersion.split(".");
  return {
    major: Number(majorRaw),
    minor: Number(minorRaw),
    patch: Number(patchRaw),
  };
};

const isAtLeastNodeVersion = (version, minimum) => {
  if (version.major !== minimum.major) {
    return version.major > minimum.major;
  }
  if (version.minor !== minimum.minor) {
    return version.minor > minimum.minor;
  }
  return version.patch >= minimum.patch;
};

const isSupportedNodeVersion = (version) => {
  if (version.major === MIN_NODE_22.major) {
    return isAtLeastNodeVersion(version, MIN_NODE_22);
  }
  if (version.major === MIN_NODE_24.major) {
    return isAtLeastNodeVersion(version, MIN_NODE_24);
  }
  if (version.major === MIN_NODE_25.major) {
    return isAtLeastNodeVersion(version, MIN_NODE_25);
  }
  return version.major > MIN_NODE_25.major;
};

const ensureSupportedRuntimeVersion = () => {
  if (process.versions.bun) {
    process.stderr.write(
      "openclaw: the Bun runtime is unsupported because OpenClaw requires node:sqlite.\n" +
        `Use Node.js ${SUPPORTED_NODE_RANGE}; Bun remains supported for installs and package scripts.\n`,
    );
    process.exit(1);
  }
  if (isSupportedNodeVersion(parseNodeVersion(process.versions.node))) {
    return;
  }

  process.stderr.write(
    `openclaw: Node.js ${SUPPORTED_NODE_RANGE} is required (current: v${process.versions.node}).\n` +
      "If you use nvm, run:\n" +
      `  nvm install ${RECOMMENDED_NODE_MAJOR}\n` +
      `  nvm use ${RECOMMENDED_NODE_MAJOR}\n` +
      `  nvm alias default ${RECOMMENDED_NODE_MAJOR}\n`,
  );
  process.exit(1);
};

ensureSupportedRuntimeVersion();

if (tryOutputLauncherVersion(process.argv)) {
  process.exit(0);
}

const isSourceCheckoutLauncher = () =>
  existsSync(new URL("./.git", import.meta.url)) ||
  existsSync(new URL("./src/entry.ts", import.meta.url));

const isNodeCompileCacheDisabled = () => process.env.NODE_DISABLE_COMPILE_CACHE !== undefined;
const isNodeCompileCacheRequested = () =>
  Boolean(process.env.NODE_COMPILE_CACHE) && !isNodeCompileCacheDisabled();
const sanitizeCompileCachePathSegment = (value) => {
  const normalized = value.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  return normalized.length > 0 ? normalized : "unknown";
};
const readPackageVersion = () => {
  try {
    const parsed = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
    if (typeof parsed?.version === "string" && parsed.version.trim().length > 0) {
      return parsed.version;
    }
  } catch {
    // Fall through to an install-metadata-only cache key.
  }
  return "unknown";
};
const resolvePackagedCompileCacheDirectory = () => {
  const packageJsonUrl = new URL("./package.json", import.meta.url);
  const version = sanitizeCompileCachePathSegment(readPackageVersion());
  let installMarker = "no-package-json";
  try {
    const stat = statSync(packageJsonUrl);
    installMarker = `${Math.trunc(stat.mtimeMs)}-${stat.size}`;
  } catch {
    // Package archives should always have package.json, but keep startup best-effort.
  }
  const baseDirectory = isNodeCompileCacheRequested()
    ? process.env.NODE_COMPILE_CACHE
    : path.join(os.tmpdir(), "node-compile-cache");
  return path.join(
    baseDirectory,
    "openclaw",
    version,
    sanitizeCompileCachePathSegment(installMarker),
  );
};

const respawnSignals =
  process.platform === "win32"
    ? ["SIGTERM", "SIGINT", "SIGBREAK"]
    : ["SIGTERM", "SIGINT", "SIGHUP", "SIGQUIT"];
const respawnSignalExitGraceMs = 1_000;
const respawnSignalForceKillGraceMs = 1_000;
const respawnSignalHardExitGraceMs = 1_000;

const runRespawnedChild = (command, args, env) => {
  const child = spawn(command, args, {
    stdio: "inherit",
    env,
  });
  const listeners = new Map();
  // This intentionally overlaps with src/entry.compile-cache.ts; keep the
  // respawn supervision behavior in sync until the launcher can share TS code.
  // Give the child a moment to honor forwarded signals, then exit the wrapper so
  // a child that ignores SIGTERM cannot keep the launcher alive indefinitely.
  let signalExitTimer = null;
  let signalForceKillTimer = null;
  let signalHardExitTimer = null;
  const detach = () => {
    for (const [signal, listener] of listeners) {
      process.off(signal, listener);
    }
    listeners.clear();
    if (signalExitTimer) {
      clearTimeout(signalExitTimer);
      signalExitTimer = null;
    }
    if (signalForceKillTimer) {
      clearTimeout(signalForceKillTimer);
      signalForceKillTimer = null;
    }
    if (signalHardExitTimer) {
      clearTimeout(signalHardExitTimer);
      signalHardExitTimer = null;
    }
  };
  const forceKillChild = () => {
    try {
      child.kill(process.platform === "win32" ? "SIGTERM" : "SIGKILL");
    } catch {
      // Best-effort shutdown fallback.
    }
  };
  const requestChildTermination = () => {
    try {
      child.kill("SIGTERM");
    } catch {
      // Best-effort shutdown fallback.
    }
    signalForceKillTimer = setTimeout(() => {
      forceKillChild();
      signalHardExitTimer = setTimeout(() => {
        process.exit(1);
      }, respawnSignalHardExitGraceMs);
      signalHardExitTimer.unref?.();
    }, respawnSignalForceKillGraceMs);
    signalForceKillTimer.unref?.();
  };
  const scheduleParentExit = () => {
    if (signalExitTimer) {
      return;
    }
    signalExitTimer = setTimeout(() => {
      requestChildTermination();
    }, respawnSignalExitGraceMs);
    signalExitTimer.unref?.();
  };
  for (const signal of respawnSignals) {
    const listener = () => {
      try {
        child.kill(signal);
      } catch {
        // Best-effort signal forwarding.
      }
      scheduleParentExit();
    };
    try {
      process.on(signal, listener);
      listeners.set(signal, listener);
    } catch {
      // Unsupported signal on this platform.
    }
  }
  child.once("exit", (code, signal) => {
    detach();
    if (signal) {
      process.exit(1);
    }
    process.exit(code ?? 1);
  });
  child.once("error", (error) => {
    detach();
    process.stderr.write(
      `[openclaw] Failed to respawn launcher: ${
        error instanceof Error ? (error.stack ?? error.message) : String(error)
      }\n`,
    );
    process.exit(1);
  });
  return true;
};

const respawnWithoutCompileCacheIfNeeded = () => {
  if (!isSourceCheckoutLauncher()) {
    return false;
  }
  if (process.env[COMPILE_CACHE_DISABLED_RESPAWNED_ENV] === "1") {
    return false;
  }
  if (!module.getCompileCacheDir?.() && !isNodeCompileCacheRequested()) {
    return false;
  }
  const env = {
    ...process.env,
    NODE_DISABLE_COMPILE_CACHE: "1",
    [COMPILE_CACHE_DISABLED_RESPAWNED_ENV]: "1",
  };
  delete env.NODE_COMPILE_CACHE;
  return runRespawnedChild(
    process.execPath,
    [...process.execArgv, fileURLToPath(import.meta.url), ...process.argv.slice(2)],
    env,
  );
};

const respawnWithPackagedCompileCacheIfNeeded = () => {
  if (isSourceCheckoutLauncher() || isNodeCompileCacheDisabled()) {
    return false;
  }
  if (process.env.OPENCLAW_PACKAGED_COMPILE_CACHE_RESPAWNED === "1") {
    return false;
  }
  const currentDirectory = module.getCompileCacheDir?.();
  if (!currentDirectory) {
    return false;
  }
  const desiredDirectory = resolvePackagedCompileCacheDirectory();
  if (path.resolve(currentDirectory) === path.resolve(desiredDirectory)) {
    return false;
  }
  const env = {
    ...process.env,
    NODE_COMPILE_CACHE: desiredDirectory,
    OPENCLAW_PACKAGED_COMPILE_CACHE_RESPAWNED: "1",
  };
  return runRespawnedChild(
    process.execPath,
    [...process.execArgv, fileURLToPath(import.meta.url), ...process.argv.slice(2)],
    env,
  );
};

const waitingForCompileCacheRespawn =
  respawnWithoutCompileCacheIfNeeded() || respawnWithPackagedCompileCacheIfNeeded();

// https://nodejs.org/api/module.html#module-compile-cache
if (
  !waitingForCompileCacheRespawn &&
  module.enableCompileCache &&
  !isNodeCompileCacheDisabled() &&
  !isSourceCheckoutLauncher()
) {
  try {
    module.enableCompileCache(resolvePackagedCompileCacheDirectory());
  } catch {
    // Ignore errors
  }
}

const getErrorMessage = (err) =>
  err && typeof err === "object" && "message" in err && typeof err.message === "string"
    ? err.message
    : "";

const isModuleNotFoundError = (err) =>
  err && typeof err === "object" && "code" in err && err.code === "ERR_MODULE_NOT_FOUND";

const isDirectModuleNotFoundError = (err, specifier) => {
  const message = getErrorMessage(err);
  const bunSpecifierMiss =
    message.includes(`Cannot find module '${specifier}'`) ||
    message.includes(`Cannot find module "${specifier}"`);
  const launcherPath = fileURLToPath(import.meta.url);
  const bunLauncherImporterMiss =
    message.includes(` from '${launcherPath}'`) || message.includes(` from "${launcherPath}"`);

  const expectedUrl = new URL(specifier, import.meta.url);
  const expectedPath = fileURLToPath(expectedUrl);
  const nodePathMiss =
    message.includes(`Cannot find module '${expectedPath}'`) ||
    message.includes(`Cannot find module "${expectedPath}"`);

  if (isModuleNotFoundError(err)) {
    if (err && typeof err === "object" && "url" in err && err.url === expectedUrl.href) {
      return true;
    }
    return nodePathMiss || (bunSpecifierMiss && bunLauncherImporterMiss);
  }

  return bunSpecifierMiss && bunLauncherImporterMiss;
};

const installProcessWarningFilter = async () => {
  // Keep bootstrap warnings consistent with the TypeScript runtime.
  for (const specifier of ["./dist/warning-filter.js", "./dist/warning-filter.mjs"]) {
    try {
      const mod = await import(specifier);
      if (typeof mod.installProcessWarningFilter === "function") {
        mod.installProcessWarningFilter();
        return;
      }
    } catch (err) {
      if (isDirectModuleNotFoundError(err, specifier)) {
        continue;
      }
      throw err;
    }
  }
};

const tryImport = async (specifier) => {
  try {
    await import(specifier);
    return true;
  } catch (err) {
    // Only swallow direct entry misses; rethrow transitive resolution failures.
    if (isDirectModuleNotFoundError(err, specifier)) {
      return false;
    }
    throw err;
  }
};

const exists = async (specifier) => {
  try {
    await access(new URL(specifier, import.meta.url));
    return true;
  } catch {
    return false;
  }
};

const buildMissingEntryErrorMessage = async () => {
  const lines = ["openclaw: missing dist/entry.(m)js (build output)."];
  if (!(await exists("./src/entry.ts"))) {
    return lines.join("\n");
  }

  lines.push("This install looks like an unbuilt source tree or GitHub source archive.");
  lines.push(
    "Build locally with `pnpm install && pnpm build`, or install a built package instead.",
  );
  lines.push(
    "For pinned GitHub installs, use `npm install -g github:openclaw/openclaw#<ref>` instead of a raw `/archive/<ref>.tar.gz` URL.",
  );
  lines.push("For releases, use `npm install -g openclaw@latest`.");
  return lines.join("\n");
};

const isBareRootHelpInvocation = (argv) =>
  argv.length === 3 && (argv[2] === "--help" || argv[2] === "-h");

const LAUNCHER_HELP_FLAGS = new Set(["-h", "--help"]);
const LAUNCHER_ROOT_BOOLEAN_FLAGS = new Set(["--dev", "--no-color"]);
const LAUNCHER_ROOT_VALUE_FLAGS = new Set(["--profile", "--log-level", "--container"]);
const LAUNCHER_PRECOMPUTED_COMMAND_HELP = {
  browser: { command: "browser", metadataKey: "browserHelpText" },
  secrets: { command: "secrets", metadataKey: "secretsHelpText" },
  nodes: { command: "nodes", metadataKey: "nodesHelpText" },
};
const LAUNCHER_PRECOMPUTED_SUBCOMMAND_HELP = new Set([
  "doctor",
  "gateway",
  "models",
  "plugins",
  "sessions",
  "tasks",
]);

const isLauncherRootOptionValueToken = (arg) => {
  if (!arg || arg === "--") {
    return false;
  }
  if (!arg.startsWith("-")) {
    return true;
  }
  return /^-\d+(?:\.\d+)?$/.test(arg);
};

const consumeLauncherRootOptionToken = (args, index) => {
  const arg = args[index];
  if (!arg) {
    return 0;
  }
  if (LAUNCHER_ROOT_BOOLEAN_FLAGS.has(arg)) {
    return 1;
  }
  if (
    arg.startsWith("--profile=") ||
    arg.startsWith("--log-level=") ||
    arg.startsWith("--container=")
  ) {
    return 1;
  }
  if (LAUNCHER_ROOT_VALUE_FLAGS.has(arg)) {
    return isLauncherRootOptionValueToken(args[index + 1]) ? 2 : 1;
  }
  return 0;
};

const hasLauncherContainerTarget = (argv) => {
  if (normalizeLauncherMetadataValue(process.env.OPENCLAW_CONTAINER)) {
    return true;
  }
  const args = argv.slice(2);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg || arg === "--") {
      return false;
    }
    if (arg === "--container" || arg.startsWith("--container=")) {
      return true;
    }
  }
  return false;
};

const resolvePrecomputedCommandHelpByName = (commandName) => {
  if (Object.hasOwn(LAUNCHER_PRECOMPUTED_COMMAND_HELP, commandName)) {
    return LAUNCHER_PRECOMPUTED_COMMAND_HELP[commandName];
  }
  if (LAUNCHER_PRECOMPUTED_SUBCOMMAND_HELP.has(commandName)) {
    return {
      command: commandName,
      metadataKey: "subcommandHelpText",
      subcommandKey: commandName,
    };
  }
  return null;
};

const resolvePrecomputedCommandHelp = (argv) => {
  const args = argv.slice(2);
  let commandHelp = null;
  let sawHelp = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg || arg === "--") {
      return null;
    }
    if (!commandHelp) {
      const consumed = consumeLauncherRootOptionToken(args, index);
      if (consumed > 0) {
        index += consumed - 1;
        continue;
      }
      if (arg.startsWith("-")) {
        return null;
      }
      commandHelp = resolvePrecomputedCommandHelpByName(arg);
      if (!commandHelp) {
        return null;
      }
      continue;
    }
    if (LAUNCHER_HELP_FLAGS.has(arg)) {
      sawHelp = true;
      continue;
    }
    return null;
  }

  return commandHelp && sawHelp ? commandHelp : null;
};

const isHelpFastPathDisabled = () =>
  process.env.OPENCLAW_DISABLE_CLI_STARTUP_HELP_FAST_PATH === "1";

const normalizeLauncherHomeValue = (value) => {
  const trimmed = value?.trim();
  return trimmed && trimmed !== "undefined" && trimmed !== "null" ? trimmed : undefined;
};

const resolveLauncherOsHomeDir = () =>
  normalizeLauncherHomeValue(process.env.HOME) ??
  normalizeLauncherHomeValue(process.env.USERPROFILE) ??
  os.homedir();

const resolveLauncherHomeDir = () => {
  const explicit = normalizeLauncherHomeValue(process.env.OPENCLAW_HOME);
  const rawHome =
    explicit && (explicit === "~" || explicit.startsWith("~/") || explicit.startsWith("~\\"))
      ? explicit.replace(/^~(?=$|[\\/])/, resolveLauncherOsHomeDir())
      : (explicit ?? resolveLauncherOsHomeDir());
  return path.resolve(rawHome);
};

const resolveLauncherUserPath = (input) => {
  if (input === "~") {
    return resolveLauncherHomeDir();
  }
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return path.join(resolveLauncherHomeDir(), input.slice(2));
  }
  return path.resolve(input);
};

const resolveLauncherConfigPaths = () => {
  const explicit = process.env.OPENCLAW_CONFIG_PATH?.trim();
  if (explicit) {
    return [resolveLauncherUserPath(explicit)];
  }
  const stateOverride = process.env.OPENCLAW_STATE_DIR?.trim();
  if (stateOverride) {
    const stateDir = resolveLauncherUserPath(stateOverride);
    return [path.join(stateDir, "openclaw.json"), path.join(stateDir, "clawdbot.json")];
  }
  const homeDir = resolveLauncherHomeDir();
  return [
    path.join(homeDir, ".openclaw", "openclaw.json"),
    path.join(homeDir, ".openclaw", "clawdbot.json"),
    path.join(homeDir, ".clawdbot", "openclaw.json"),
    path.join(homeDir, ".clawdbot", "clawdbot.json"),
  ];
};

const shouldDeferRootHelpToRuntimeEntry = () => {
  if (
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR?.trim() ||
    process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS?.trim()
  ) {
    return true;
  }
  for (const configPath of resolveLauncherConfigPaths()) {
    try {
      const raw = readFileSync(configPath, "utf8");
      return /\bplugins\b|\$include\b/.test(raw);
    } catch {
      continue;
    }
  }
  return false;
};

const loadPrecomputedHelpText = (key, subkey) => {
  try {
    const raw = readFileSync(new URL("./dist/cli-startup-metadata.json", import.meta.url), "utf8");
    const parsed = JSON.parse(raw);
    const value = subkey ? parsed?.[key]?.[subkey] : parsed?.[key];
    return typeof value === "string" && value.length > 0 ? value : null;
  } catch {
    return null;
  }
};

function tryOutputLauncherVersion(argv) {
  try {
    if (normalizeLauncherMetadataValue(process.env.OPENCLAW_CONTAINER)) {
      return false;
    }
    if (!isLauncherVersionFastPathArgv(argv)) {
      return false;
    }
    const version = resolveLauncherVersion();
    const commit = resolveLauncherCommit();
    process.stdout.write(commit ? `OpenClaw ${version} (${commit})\n` : `OpenClaw ${version}\n`);
    return true;
  } catch {
    return false;
  }
}

function isLauncherVersionFastPathArgv(argv) {
  return argv.length === 3 && (argv[2] === "--version" || argv[2] === "-V" || argv[2] === "-v");
}

function normalizeLauncherMetadataValue(value) {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed && trimmed !== "undefined" && trimmed !== "null" ? trimmed : undefined;
}

function readLauncherJson(relativePath) {
  try {
    return JSON.parse(readFileSync(new URL(relativePath, import.meta.url), "utf8"));
  } catch {
    return null;
  }
}

function resolveLauncherVersion() {
  const packageJson = readLauncherJson("./package.json");
  const packageVersion = normalizeLauncherMetadataValue(packageJson?.version);
  if (packageVersion) {
    return packageVersion;
  }
  const buildInfo = readLauncherJson("./dist/build-info.json");
  const buildVersion = normalizeLauncherMetadataValue(buildInfo?.version);
  if (buildVersion) {
    return buildVersion;
  }
  return normalizeLauncherMetadataValue(process.env.OPENCLAW_BUNDLED_VERSION) ?? "0.0.0";
}

function resolveLauncherCommit() {
  const envCommit = formatLauncherCommit(process.env.GIT_COMMIT ?? process.env.GIT_SHA);
  if (envCommit) {
    return envCommit;
  }
  return (
    readLauncherGitCommit() ??
    formatLauncherCommit(readLauncherJson("./dist/build-info.json")?.commit) ??
    formatLauncherCommit(readLauncherJson("./package.json")?.gitHead) ??
    formatLauncherCommit(readLauncherJson("./package.json")?.githead)
  );
}

function formatLauncherCommit(value) {
  if (typeof value !== "string") {
    return null;
  }
  const match = value.trim().match(/[0-9a-fA-F]{7,40}/);
  return match ? match[0].slice(0, 7).toLowerCase() : null;
}

function readLauncherGitCommit() {
  try {
    const gitPath = fileURLToPath(new URL("./.git", import.meta.url));
    const headPath = resolveLauncherGitHeadPath(gitPath);
    if (!headPath) {
      return null;
    }
    const head = readFileSync(headPath, "utf8").trim();
    if (!head) {
      return null;
    }
    if (!head.startsWith("ref:")) {
      return formatLauncherCommit(head);
    }
    const ref = head.replace(/^ref:\s*/i, "").trim();
    if (!ref.startsWith("refs/") || path.isAbsolute(ref) || ref.split("/").includes("..")) {
      return null;
    }
    const refsBase = resolveLauncherGitRefsBase(headPath);
    const refPath = path.resolve(refsBase, ref);
    const rel = path.relative(refsBase, refPath);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
      return null;
    }
    try {
      return formatLauncherCommit(readFileSync(refPath, "utf8"));
    } catch {
      return readLauncherPackedRef(refsBase, ref);
    }
  } catch {
    return null;
  }
}

function resolveLauncherGitHeadPath(gitPath) {
  try {
    if (statSync(gitPath).isDirectory()) {
      return path.join(gitPath, "HEAD");
    }
    const raw = readFileSync(gitPath, "utf8").trim();
    if (!raw.startsWith("gitdir:")) {
      return null;
    }
    return path.join(
      path.resolve(path.dirname(gitPath), raw.slice("gitdir:".length).trim()),
      "HEAD",
    );
  } catch {
    return null;
  }
}

function resolveLauncherGitRefsBase(headPath) {
  const gitDir = path.dirname(headPath);
  try {
    const commonDir = readFileSync(path.join(gitDir, "commondir"), "utf8").trim();
    return commonDir ? path.resolve(gitDir, commonDir) : gitDir;
  } catch {
    return gitDir;
  }
}

function readLauncherPackedRef(refsBase, ref) {
  try {
    const packedRefs = readFileSync(path.join(refsBase, "packed-refs"), "utf8");
    for (const line of packedRefs.split("\n")) {
      if (!line || line.startsWith("#") || line.startsWith("^")) {
        continue;
      }
      const [commit, packedRef] = line.trim().split(/\s+/, 2);
      if (packedRef === ref) {
        return formatLauncherCommit(commit);
      }
    }
  } catch {
    // fall through
  }
  return null;
}

const tryOutputBareRootHelp = async () => {
  if (!isBareRootHelpInvocation(process.argv)) {
    return false;
  }
  if (shouldDeferRootHelpToRuntimeEntry()) {
    return false;
  }
  const precomputed = loadPrecomputedHelpText("rootHelpText");
  if (precomputed) {
    process.stdout.write(precomputed);
    return true;
  }
  for (const specifier of ["./dist/cli/program/root-help.js", "./dist/cli/program/root-help.mjs"]) {
    try {
      const mod = await import(specifier);
      if (typeof mod.outputRootHelp === "function") {
        await mod.outputRootHelp();
        return true;
      }
    } catch (err) {
      if (isDirectModuleNotFoundError(err, specifier)) {
        continue;
      }
      throw err;
    }
  }
  return false;
};

const tryOutputPrecomputedCommandHelp = () => {
  const commandHelp = resolvePrecomputedCommandHelp(process.argv);
  if (!commandHelp) {
    return false;
  }
  if (hasLauncherContainerTarget(process.argv)) {
    return false;
  }
  if (commandHelp.command === "nodes" && shouldDeferRootHelpToRuntimeEntry()) {
    return false;
  }
  const precomputed = loadPrecomputedHelpText(commandHelp.metadataKey, commandHelp.subcommandKey);
  if (!precomputed) {
    return false;
  }
  process.stdout.write(precomputed);
  return true;
};

if (!waitingForCompileCacheRespawn) {
  if (!isHelpFastPathDisabled() && (await tryOutputBareRootHelp())) {
    // OK
  } else if (!isHelpFastPathDisabled() && tryOutputPrecomputedCommandHelp()) {
    // OK
  } else {
    await installProcessWarningFilter();
    if (await tryImport("./dist/entry.js")) {
      // OK
    } else if (await tryImport("./dist/entry.mjs")) {
      // OK
    } else {
      throw new Error(await buildMissingEntryErrorMessage());
    }
  }
}
