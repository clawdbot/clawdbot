import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, win32 as pathWin32 } from "node:path";
import { pathToFileURL } from "node:url";
import { isLocalBuildMetadataDistPath } from "../local-build-metadata-paths.mjs";
import type { CandidateBuild, LaneCommandParams, LaneState, PackageJson } from "./config.ts";
import {
  CROSS_OS_NPM_DEBUG_LOG_TAIL_BYTES,
  INSTALL_STAGE_DEBRIS_DIR_PATTERN,
  OMITTED_QA_EXTENSION_PREFIXES,
  PACKAGE_DIST_INVENTORY_RELATIVE_PATH,
  PUBLISHED_INSTALLER_BASE_URL,
  installTimeoutMs,
  resolvePackDestinationTarball,
  shouldRunBundledPluginPostinstall,
} from "./config.ts";
import { readLogTextWindow } from "./logs.ts";
import { runCommand } from "./process.ts";
import { logPhase } from "./reporting.ts";
import { formatError, resolveCommandPath, shellEscapeForSh } from "./shared.ts";

export async function prepareCandidate(params: {
  outputDir: string;
  sourceDir: string;
  logsDir: string;
}): Promise<CandidateBuild> {
  logPhase("prepare", "resolve-source-sha");
  const packageJson = readPackageJson(params.sourceDir);
  const hasUiBuildScript = packageJsonHasScript(packageJson, "ui:build");
  const sourceSha = (
    await runCommand(gitCommand(), ["rev-parse", "HEAD"], {
      cwd: params.sourceDir,
      logPath: join(params.logsDir, "git-rev-parse.log"),
    })
  ).stdout.trim();

  const buildEnv = {
    ...process.env,
    NODE_OPTIONS: "--max-old-space-size=8192",
  };

  logPhase("prepare", "pnpm-install");
  await runCommand(pnpmCommand(), ["install", "--frozen-lockfile"], {
    cwd: params.sourceDir,
    env: buildEnv,
    logPath: join(params.logsDir, "pnpm-install.log"),
    timeoutMs: 45 * 60 * 1000,
  });

  logPhase("prepare", "pnpm-build");
  await runCommand(pnpmCommand(), ["build"], {
    cwd: params.sourceDir,
    env: buildEnv,
    logPath: join(params.logsDir, "pnpm-build.log"),
    timeoutMs: 45 * 60 * 1000,
  });

  if (hasUiBuildScript) {
    // pnpm build does not regenerate dist/control-ui, and checked-in bundles can
    // otherwise leak into npm pack when a ref changes UI assets.
    logPhase("prepare", "pnpm-ui-build");
    await runCommand(pnpmCommand(), ["ui:build"], {
      cwd: params.sourceDir,
      env: buildEnv,
      logPath: join(params.logsDir, "pnpm-ui-build.log"),
      timeoutMs: 30 * 60 * 1000,
    });
  }

  const packDir = join(params.outputDir, "package");
  mkdirSync(packDir, { recursive: true });
  const packJsonPath = join(packDir, "pack.json");
  logPhase("prepare", "package-dist-inventory");
  await writePackageDistInventoryForCandidate({
    sourceDir: params.sourceDir,
    logPath: join(params.logsDir, "pnpm-pack-dry-run.log"),
  });
  const packCommand = resolvePackageCandidatePackCommand(params.sourceDir, packDir);
  logPhase("prepare", packCommand.phase);
  const packResult = await runCommand(packCommand.command, packCommand.args, {
    cwd: params.sourceDir,
    logPath: join(params.logsDir, packCommand.logFileName),
    timeoutMs: 15 * 60 * 1000,
  });
  const packedCandidate = resolvePackedCandidateFromOutput({
    output: packResult.stdout,
    packDir,
    packageJson,
    packCommand,
  });
  writeFileSync(packJsonPath, packedCandidate.packJson, "utf8");

  return {
    sourceDir: params.sourceDir,
    sourceSha,
    candidateVersion: packedCandidate.version,
    candidateTgz: packedCandidate.path,
    candidateFileName: packedCandidate.fileName,
  };
}

export function resolvePackageCandidatePackCommand(sourceDir: string, packDir: string) {
  const packageHelper = join(sourceDir, "scripts", "package-openclaw-for-docker.mjs");
  if (existsSync(packageHelper)) {
    return {
      args: [packageHelper, "--skip-build", "--output-dir", packDir],
      command: process.execPath,
      kind: "docker-helper",
      logFileName: "package-candidate.log",
      phase: "package-candidate",
    };
  }

  return {
    args: ["pack", "--config.ignore-scripts=true", "--json", "--pack-destination", packDir],
    command: pnpmCommand(),
    kind: "pnpm-pack",
    logFileName: "pnpm-pack.log",
    phase: "pnpm-pack",
  };
}

function resolvePackedCandidateFromOutput(params: {
  output: string;
  packDir: string;
  packageJson: PackageJson;
  packCommand: ReturnType<typeof resolvePackageCandidatePackCommand>;
}) {
  if (params.packCommand.kind === "docker-helper") {
    const packOutputLines = params.output.trim().split(/\r?\n/u).filter(Boolean);
    const packedTarball = resolvePackDestinationTarball(
      packOutputLines.at(-1),
      params.packDir,
      "package-openclaw-for-docker",
    );
    return {
      fileName: packedTarball.fileName,
      packJson: `${JSON.stringify(
        {
          filename: packedTarball.fileName,
          path: packedTarball.path,
          version: params.packageJson.version,
        },
        null,
        2,
      )}\n`,
      path: packedTarball.path,
      version: (params.packageJson.version ?? "").trim(),
    };
  }

  const parsedPack = JSON.parse(params.output) as
    | { filename?: string; version?: string }
    | Array<{ filename?: string; version?: string }>;
  const lastPack = Array.isArray(parsedPack) ? parsedPack.at(-1) : parsedPack;
  const packedTarball = resolvePackDestinationTarball(
    lastPack?.filename,
    params.packDir,
    "pnpm pack",
  );
  return {
    fileName: packedTarball.fileName,
    packJson: params.output,
    path: packedTarball.path,
    version: (lastPack?.version ?? params.packageJson.version ?? "").trim(),
  };
}

function normalizeRelativePath(value: string) {
  return value.replace(/\\/gu, "/");
}

function isNotFoundError(error: unknown) {
  return error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT";
}

function isInstallStageDirName(value: string) {
  return INSTALL_STAGE_DEBRIS_DIR_PATTERN.test(value);
}

function collectLegacyPluginDependencyStagingDebrisPaths(packageRoot: string) {
  const rootEntries = readdirSync(packageRoot, { withFileTypes: true });
  const debris: string[] = [];
  for (const rootEntry of rootEntries) {
    if (!rootEntry.isDirectory() || rootEntry.name.toLowerCase() !== "dist") {
      continue;
    }
    const distDir = join(packageRoot, rootEntry.name);
    let distEntries;
    try {
      distEntries = readdirSync(distDir, { withFileTypes: true });
    } catch (error) {
      if (isNotFoundError(error)) {
        continue;
      }
      throw error;
    }
    for (const distEntry of distEntries) {
      if (!distEntry.isDirectory() || distEntry.name.toLowerCase() !== "extensions") {
        continue;
      }
      const extensionsDir = join(distDir, distEntry.name);
      let extensionEntries;
      try {
        extensionEntries = readdirSync(extensionsDir, { withFileTypes: true });
      } catch (error) {
        if (isNotFoundError(error)) {
          continue;
        }
        throw error;
      }

      for (const extensionEntry of extensionEntries) {
        if (!extensionEntry.isDirectory()) {
          continue;
        }
        const extensionPath = join(extensionsDir, extensionEntry.name);
        let stagingEntries;
        try {
          stagingEntries = readdirSync(extensionPath, { withFileTypes: true });
        } catch (error) {
          if (isNotFoundError(error)) {
            continue;
          }
          throw error;
        }
        for (const stagingEntry of stagingEntries) {
          if (isInstallStageDirName(stagingEntry.name)) {
            debris.push(
              normalizeRelativePath(relative(packageRoot, join(extensionPath, stagingEntry.name))),
            );
          }
        }
      }
    }
  }
  return debris.toSorted((left, right) => left.localeCompare(right));
}

function assertNoLegacyPluginDependencyStagingDebris(packageRoot: string) {
  const debris = collectLegacyPluginDependencyStagingDebrisPaths(packageRoot);
  if (debris.length === 0) {
    return;
  }
  throw new Error(
    `unexpected legacy plugin dependency staging debris in package dist: ${debris.join(", ")}`,
  );
}

function isPackagedDistPath(relativePath: string) {
  if (!relativePath.startsWith("dist/")) {
    return false;
  }
  if (relativePath === PACKAGE_DIST_INVENTORY_RELATIVE_PATH) {
    return false;
  }
  if (isLocalBuildMetadataDistPath(relativePath)) {
    return false;
  }
  if (relativePath.endsWith(".map")) {
    return false;
  }
  if (relativePath === "dist/plugin-sdk/.tsbuildinfo") {
    return false;
  }
  if (OMITTED_QA_EXTENSION_PREFIXES.some((prefix) => relativePath.startsWith(prefix))) {
    return false;
  }
  return true;
}

export async function writePackageDistInventoryForCandidate(params: {
  sourceDir: string;
  logPath: string;
}) {
  assertNoLegacyPluginDependencyStagingDebris(params.sourceDir);
  const dryRun = await runCommand(
    pnpmCommand(),
    ["pack", "--dry-run", "--config.ignore-scripts=true", "--json"],
    {
      cwd: params.sourceDir,
      logPath: params.logPath,
      timeoutMs: 5 * 60 * 1000,
    },
  );
  const parsedPack = JSON.parse(dryRun.stdout) as
    | { files?: Array<{ path?: string }> }
    | Array<{ files?: Array<{ path?: string }> }>;
  const lastPack = Array.isArray(parsedPack) ? parsedPack.at(-1) : parsedPack;
  const files = Array.isArray(lastPack?.files) ? lastPack.files : [];
  if (files.length === 0) {
    throw new Error(
      "pnpm pack --dry-run did not report package files for dist inventory generation.",
    );
  }
  const inventory = files
    .flatMap((entry) => {
      const relativePath = normalizeRelativePath((entry.path ?? "").trim());
      return isPackagedDistPath(relativePath) ? [relativePath] : [];
    })
    .toSorted((left, right) => left.localeCompare(right));
  const inventoryPath = join(params.sourceDir, PACKAGE_DIST_INVENTORY_RELATIVE_PATH);
  mkdirSync(dirname(inventoryPath), { recursive: true });
  writeFileSync(inventoryPath, `${JSON.stringify(inventory, null, 2)}\n`, "utf8");
}

export function readProvidedCandidate(params: {
  candidateTgz: string;
  candidateVersion: string;
  sourceSha: string;
}): CandidateBuild {
  if (!params.candidateTgz) {
    throw new Error("Missing required --candidate-tgz argument when --source-dir is not provided.");
  }
  if (!existsSync(params.candidateTgz)) {
    throw new Error(`Candidate package not found: ${params.candidateTgz}`);
  }
  if (!params.candidateVersion) {
    throw new Error(
      "Missing required --candidate-version argument when --source-dir is not provided.",
    );
  }
  if (!params.sourceSha) {
    throw new Error("Missing required --source-sha argument when --source-dir is not provided.");
  }
  return {
    sourceDir: "",
    sourceSha: params.sourceSha,
    candidateVersion: params.candidateVersion,
    candidateTgz: params.candidateTgz,
    candidateFileName: params.candidateTgz.split(/[/\\]/u).at(-1) ?? "",
  };
}

export function readPackageJson(packageRoot: string): PackageJson {
  return JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as PackageJson;
}

export function packageJsonHasScript(packageJson: PackageJson, scriptName: string) {
  return typeof packageJson?.scripts?.[scriptName] === "string";
}

export function packageHasScript(packageRoot: string, scriptName: string) {
  try {
    return packageJsonHasScript(readPackageJson(packageRoot), scriptName);
  } catch {
    return false;
  }
}

export function normalizeWindowsInstalledCliPath(cliPath: string) {
  return normalizeWindowsCommandShimPath(cliPath);
}

export function normalizeWindowsCommandShimPath(commandPath: string) {
  if (typeof commandPath !== "string") {
    return commandPath;
  }
  return commandPath.replace(/\.ps1$/iu, ".cmd");
}

export function resolveInstalledPrefixDirFromCliPath(cliPath: string, platform = process.platform) {
  const resolvedCliPath =
    platform === "win32" ? normalizeWindowsInstalledCliPath(cliPath) : cliPath;
  if (!resolvedCliPath?.trim()) {
    throw new Error("Missing installed CLI path.");
  }
  if (platform === "win32") {
    return pathWin32.dirname(resolvedCliPath);
  }
  return dirname(dirname(resolvedCliPath));
}

export async function installTarballPackage(params: {
  lane: LaneState;
  env: NodeJS.ProcessEnv;
  tgzPath: string;
  logPath: string;
  timeoutMs?: number;
  ignoreScripts?: boolean;
  restoreBundledPluginPostinstall?: boolean;
}) {
  await installPackageSpec({
    lane: params.lane,
    env: params.env,
    packageSpec: params.tgzPath,
    logPath: params.logPath,
    timeoutMs: params.timeoutMs,
    ignoreScripts: params.ignoreScripts,
  });
  if (
    params.restoreBundledPluginPostinstall !== false &&
    shouldRunBundledPluginPostinstall({ lane: params.lane })
  ) {
    await runBundledPluginPostinstall({
      lane: params.lane,
      env: params.env,
      logPath: params.logPath,
    });
  }
}

export async function installPackageSpec(params: {
  lane: LaneState;
  env: NodeJS.ProcessEnv;
  packageSpec: string;
  logPath: string;
  timeoutMs?: number;
  ignoreScripts?: boolean;
}) {
  const installEnv = {
    ...params.env,
    npm_config_global: "true",
    npm_config_location: "global",
    npm_config_prefix: params.lane.prefixDir,
  };
  rmSync(installedPackageRoot(params.lane.prefixDir), { force: true, recursive: true });
  try {
    await runCommand(
      npmCommand(),
      buildNpmGlobalInstallArgs(params.packageSpec, { ignoreScripts: params.ignoreScripts }),
      {
        cwd: params.lane.homeDir,
        env: installEnv,
        logPath: params.logPath,
        timeoutMs: params.timeoutMs ?? installTimeoutMs(),
      },
    );
  } catch (error) {
    const debugTail = appendLatestNpmDebugLogTail(params.lane.homeDir, params.logPath, installEnv);
    if (!debugTail) {
      throw error;
    }
    throw new Error(`${formatError(error)}\n\nnpm debug log tail:\n${debugTail}`, { cause: error });
  }
}

export function appendLatestNpmDebugLogTail(
  homeDir: string,
  logPath: string,
  env = process.env,
  platform = process.platform,
) {
  try {
    const candidates = resolveNpmDebugLogDirs(homeDir, env, platform)
      .flatMap(findNpmDebugLogs)
      .toSorted((left, right) => left.mtimeMs - right.mtimeMs);
    const latest = candidates.at(-1);
    if (!latest) {
      return "";
    }

    const tail = readLogTextWindow(latest.path, { maxBytes: CROSS_OS_NPM_DEBUG_LOG_TAIL_BYTES });
    if (!tail.trim()) {
      return "";
    }

    appendFileSync(
      logPath,
      `\n${new Date().toISOString()} npm-debug-log path=${latest.path}\n${tail}\n`,
      "utf8",
    );
    return tail;
  } catch {
    return "";
  }
}

export function resolveNpmDebugLogDirs(
  homeDir: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
) {
  const configuredLogsDir = resolveNpmConfiguredPath(
    homeDir,
    env.npm_config_logs_dir ?? env.NPM_CONFIG_LOGS_DIR,
    platform,
  );
  const configuredCache = resolveNpmConfiguredPath(
    homeDir,
    env.npm_config_cache ?? env.NPM_CONFIG_CACHE,
    platform,
  );
  const localAppData = (env.LOCALAPPDATA ?? "").trim();
  const logDirs = [
    configuredLogsDir,
    configuredCache ? normalizeNpmCacheLogDir(configuredCache) : "",
    platform === "win32" && localAppData ? join(localAppData, "npm-cache", "_logs") : "",
    join(homeDir, ".npm", "_logs"),
  ].filter(Boolean);
  return [...new Set(logDirs)];
}

function resolveNpmConfiguredPath(
  homeDir: string,
  value: string | undefined,
  platform: NodeJS.Platform,
) {
  const raw = (value ?? "").trim();
  if (!raw) {
    return "";
  }
  return platform === "win32" ? pathWin32.resolve(homeDir, raw) : resolve(homeDir, raw);
}

function normalizeNpmCacheLogDir(logDir: string) {
  return logDir.endsWith("/_logs") || logDir.endsWith("\\_logs") ? logDir : join(logDir, "_logs");
}

function findNpmDebugLogs(logsDir: string) {
  if (!existsSync(logsDir)) {
    return [];
  }

  return readdirSync(logsDir)
    .flatMap((fileName) => {
      if (!fileName.endsWith("-debug-0.log")) {
        return [];
      }
      const path = join(logsDir, fileName);
      try {
        const stat = statSync(path);
        return stat.isFile() ? [{ path, mtimeMs: stat.mtimeMs }] : [];
      } catch {
        return [];
      }
    })
    .toSorted((left, right) => left.mtimeMs - right.mtimeMs);
}

export function buildNpmGlobalInstallArgs(
  packageSpec: string,
  options: { ignoreScripts?: boolean } = {},
) {
  return [
    "install",
    "-g",
    packageSpec,
    "--omit=dev",
    "--no-fund",
    "--no-audit",
    ...(options.ignoreScripts ? ["--ignore-scripts"] : []),
    "--loglevel=notice",
  ];
}

export async function runBundledPluginPostinstall(params: LaneCommandParams) {
  const packageRoot = installedPackageRoot(params.lane.prefixDir);
  const scriptPath = join(packageRoot, "scripts", "postinstall-bundled-plugins.mjs");
  if (!existsSync(scriptPath)) {
    return;
  }
  const installEnv = {
    ...params.env,
  };
  delete installEnv.OPENCLAW_DISABLE_BUNDLED_PLUGIN_POSTINSTALL;
  delete installEnv.NPM_CONFIG_PREFIX;
  delete installEnv.npm_config_global;
  delete installEnv.npm_config_location;
  delete installEnv.npm_config_prefix;

  await runCommand(process.execPath, [scriptPath], {
    cwd: packageRoot,
    env: installEnv,
    logPath: params.logPath,
    timeoutMs: 20 * 60 * 1000,
  });
}

export function shouldRunWindowsInstalledBrowserOverrideImportSmoke(platform = process.platform) {
  return platform === "win32";
}

export function buildInstalledBrowserOverrideImportProbeScript(
  runtimeModuleSpecifier = "openclaw/plugin-sdk/plugin-runtime",
) {
  return `
import { existsSync } from "node:fs";
import { startLazyPluginServiceModule } from ${JSON.stringify(runtimeModuleSpecifier)};

const startedPath = process.env.OPENCLAW_BROWSER_OVERRIDE_STARTED_PATH;
const stoppedPath = process.env.OPENCLAW_BROWSER_OVERRIDE_STOPPED_PATH;

if (!process.env.OPENCLAW_BROWSER_CONTROL_MODULE) {
  throw new Error("Missing OPENCLAW_BROWSER_CONTROL_MODULE.");
}
if (!startedPath || !stoppedPath) {
  throw new Error("Missing browser override sentinel path env.");
}

const handle = await startLazyPluginServiceModule({
  overrideEnvVar: "OPENCLAW_BROWSER_CONTROL_MODULE",
  validateOverrideSpecifier: (specifier) => specifier,
  loadDefaultModule: async () => {
    throw new Error("Default browser control service should not load during override probe.");
  },
  startExportNames: ["startBrowserControlService"],
  stopExportNames: ["stopBrowserControlService"],
});

if (!handle) {
  throw new Error("Browser control override probe did not return a service handle.");
}
if (!existsSync(startedPath)) {
  throw new Error("Browser control override start sentinel was not written.");
}

await handle.stop();

if (!existsSync(stoppedPath)) {
  throw new Error("Browser control override stop sentinel was not written.");
}

console.log("windows browser override import OK");
`.trim();
}

function buildBrowserOverrideProbeServiceModule() {
  return `
import { writeFileSync } from "node:fs";

export async function startBrowserControlService() {
  writeFileSync(process.env.OPENCLAW_BROWSER_OVERRIDE_STARTED_PATH, "started\\n", "utf8");
}

export async function stopBrowserControlService() {
  writeFileSync(process.env.OPENCLAW_BROWSER_OVERRIDE_STOPPED_PATH, "stopped\\n", "utf8");
}
`.trim();
}

export async function runInstalledBrowserOverrideImportSmoke(
  params: LaneCommandParams & { prefixDir: string },
) {
  if (!shouldRunWindowsInstalledBrowserOverrideImportSmoke()) {
    return "skipped";
  }

  const probeDir = join(params.lane.rootDir, "browser override import probe");
  mkdirSync(probeDir, { recursive: true });
  const overridePath = join(probeDir, "browser override #module.mjs");
  const probePath = join(probeDir, "run browser override probe.mjs");
  const startedPath = join(probeDir, "started.txt");
  const stoppedPath = join(probeDir, "stopped.txt");
  const packageRoot = installedPackageRoot(params.prefixDir);
  const runtimeModulePath = join(packageRoot, "dist", "plugin-sdk", "plugin-runtime.js");
  if (!existsSync(runtimeModulePath)) {
    throw new Error(`Installed browser runtime module not found: ${runtimeModulePath}`);
  }

  writeFileSync(overridePath, `${buildBrowserOverrideProbeServiceModule()}\n`, "utf8");
  writeFileSync(
    probePath,
    `${buildInstalledBrowserOverrideImportProbeScript(pathToFileURL(runtimeModulePath).href)}\n`,
    "utf8",
  );

  await runCommand(process.execPath, [probePath], {
    cwd: packageRoot,
    env: {
      ...params.env,
      OPENCLAW_BROWSER_CONTROL_MODULE: pathToFileURL(overridePath).href,
      OPENCLAW_BROWSER_OVERRIDE_STARTED_PATH: startedPath,
      OPENCLAW_BROWSER_OVERRIDE_STOPPED_PATH: stoppedPath,
    },
    logPath: params.logPath,
    timeoutMs: 60_000,
  });

  if (!existsSync(startedPath) || !existsSync(stoppedPath)) {
    throw new Error("Browser control override import probe did not write both sentinels.");
  }

  return "pass";
}

export function ensureLocalNpmShim(lane: LaneState) {
  const shimPath = npmShimPath(lane.prefixDir);
  if (existsSync(shimPath)) {
    return;
  }
  mkdirSync(dirname(shimPath), { recursive: true });
  const resolvedNpm = resolveCommandPath(npmCommand());
  if (!resolvedNpm) {
    throw new Error(`Failed to resolve ${npmCommand()} on PATH.`);
  }
  if (process.platform === "win32") {
    writeFileSync(
      shimPath,
      `@echo off\r\nset "NPM_CONFIG_PREFIX=${lane.prefixDir}"\r\n"${resolvedNpm}" %*\r\n`,
      "utf8",
    );
    return;
  }
  writeFileSync(
    shimPath,
    `#!/bin/sh\nexport NPM_CONFIG_PREFIX='${shellEscapeForSh(lane.prefixDir)}'\nexec '${shellEscapeForSh(resolvedNpm)}' "$@"\n`,
    "utf8",
  );
  chmodSync(shimPath, 0o755);
}

function readInstalledPackageManifest(prefixDir: string) {
  const packageRoot = installedPackageRoot(prefixDir);
  return readInstalledPackageManifestFromPackageRoot(packageRoot);
}

function readInstalledPackageManifestFromPackageRoot(packageRoot: string) {
  const packageJsonPath = join(packageRoot, "package.json");
  if (!existsSync(packageJsonPath)) {
    throw new Error(`Installed package manifest missing: ${packageJsonPath}`);
  }
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as PackageJson;
  return { packageJson, packageRoot };
}

export function readInstalledVersion(prefixDir: string) {
  const { packageJson } = readInstalledPackageManifest(prefixDir);
  return typeof packageJson.version === "string" ? packageJson.version.trim() : "";
}

export function readInstalledMetadataFromCliPath(cliPath: string, platform = process.platform) {
  return readInstalledMetadataFromPackageRoot(
    resolveInstalledPackageRootFromCliPath(cliPath, platform),
  );
}

export function readInstalledMetadata(prefixDir: string) {
  const { packageJson, packageRoot } = readInstalledPackageManifest(prefixDir);
  return readInstalledMetadataFromManifest(packageJson, packageRoot);
}

export function readInstalledMetadataFromPackageRoot(packageRoot: string) {
  const { packageJson } = readInstalledPackageManifestFromPackageRoot(packageRoot);
  return readInstalledMetadataFromManifest(packageJson, packageRoot);
}

function readInstalledMetadataFromManifest(packageJson: PackageJson, packageRoot: string) {
  const buildInfoPath = join(packageRoot, "dist", "build-info.json");
  if (!existsSync(buildInfoPath)) {
    throw new Error(`Installed build info missing: ${buildInfoPath}`);
  }
  const buildInfo = JSON.parse(readFileSync(buildInfoPath, "utf8")) as {
    commit?: unknown;
  };
  return {
    version: typeof packageJson.version === "string" ? packageJson.version.trim() : "",
    commit: typeof buildInfo.commit === "string" ? buildInfo.commit.trim() : "",
  };
}

export function verifyInstalledCandidate(
  installed: { version: string; commit: string },
  build: CandidateBuild,
) {
  if (installed.version !== build.candidateVersion) {
    throw new Error(
      `Installed version mismatch. Expected ${build.candidateVersion}, found ${installed.version || "<missing>"}.`,
    );
  }
  if (installed.commit !== build.sourceSha) {
    throw new Error(
      `Installed build commit mismatch. Expected ${build.sourceSha}, found ${installed.commit || "<missing>"}.`,
    );
  }
}

export function resolveInstalledPackageRootFromCliPath(
  cliPath: string,
  platform = process.platform,
  env = process.env,
) {
  const prefixDir = resolveInstalledPrefixDirFromCliPath(cliPath, platform);
  const candidates = [installedPackageRoot(prefixDir, platform)];

  if (platform !== "win32") {
    const resolvedCliPath = cliPath.trim();
    if (resolvedCliPath) {
      try {
        const realCliPath = realpathSync(resolvedCliPath);
        candidates.push(dirname(realCliPath));
        candidates.push(dirname(dirname(realCliPath)));
      } catch {
        // Some installer shims are shell wrappers, not symlinks. Fall through to
        // common user-local npm prefixes below.
      }
    }

    for (const prefix of [
      env.NPM_CONFIG_PREFIX,
      env.npm_config_prefix,
      env.HOME && join(env.HOME, ".npm-global"),
      env.HOME && join(env.HOME, ".local"),
    ]) {
      if (typeof prefix === "string" && prefix.trim()) {
        candidates.push(installedPackageRoot(prefix, platform));
      }
    }
  }

  const checked: string[] = [];
  for (const candidate of candidates) {
    if (!candidate || checked.includes(candidate)) {
      continue;
    }
    checked.push(candidate);
    if (existsSync(join(candidate, "package.json"))) {
      return candidate;
    }
  }

  throw new Error(`Installed package manifest missing. Checked: ${checked.join(", ")}`);
}

export function installedPackageRoot(prefixDir: string, platform = process.platform) {
  return platform === "win32"
    ? join(prefixDir, "node_modules", "openclaw")
    : join(prefixDir, "lib", "node_modules", "openclaw");
}

export function installedEntryPath(prefixDir: string) {
  return join(installedPackageRoot(prefixDir), "openclaw.mjs");
}

export function npmShimPath(prefixDir: string) {
  return process.platform === "win32" ? join(prefixDir, "npm.cmd") : join(prefixDir, "bin", "npm");
}

export function binDirForPrefix(prefixDir: string) {
  return process.platform === "win32" ? prefixDir : join(prefixDir, "bin");
}

export function pnpmCommand() {
  return process.platform === "win32" ? "pnpm.cmd" : "pnpm";
}

export function npmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

export function gitCommand() {
  return process.platform === "win32" ? "git.exe" : "git";
}

export function resolvePublishedInstallerUrl(platform = process.platform) {
  if (platform === "win32") {
    return `${PUBLISHED_INSTALLER_BASE_URL}/install.ps1`;
  }
  return `${PUBLISHED_INSTALLER_BASE_URL}/install.sh`;
}
