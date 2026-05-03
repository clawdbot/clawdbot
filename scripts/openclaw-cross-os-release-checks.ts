#!/usr/bin/env -S node --import tsx

// Executed directly via Node.js + tsx in the release workflow.

import { spawn } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { createConnection as createNetConnection, createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve, win32 as pathWin32 } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertNoLegacyPluginDependencyStagingDebris } from "../src/infra/package-dist-inventory.ts";
import { isLocalBuildMetadataDistPath } from "./lib/local-build-metadata-paths.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const PUBLISHED_INSTALLER_BASE_URL = "https://openclaw.ai";

const SUPPORTED_MODES = new Set(["fresh", "upgrade", "both"]);
const SUPPORTED_SUITES = new Set([
  "packaged-fresh",
  "installer-fresh",
  "packaged-upgrade",
  "dev-update",
]);

export const CROSS_OS_AGENT_TURN_TIMEOUT_SECONDS = parsePositiveIntegerEnv(
  "OPENCLAW_CROSS_OS_AGENT_TURN_TIMEOUT_SECONDS",
  600,
);
const CROSS_OS_AGENT_TURN_OPTIONAL = parseBooleanEnv("OPENCLAW_CROSS_OS_AGENT_TURN_OPTIONAL", true);

const providerConfig = {
  openai: {
    extensionId: "openai",
    secretEnv: "OPENAI_API_KEY",
    authChoice: "openai-api-key",
    model: "openai/gpt-5.4",
    baseUrl: "https://api.openai.com/v1",
    timeoutSeconds: CROSS_OS_AGENT_TURN_TIMEOUT_SECONDS,
  },
  anthropic: {
    extensionId: "anthropic",
    secretEnv: "ANTHROPIC_API_KEY",
    authChoice: "apiKey",
    model: "anthropic/claude-sonnet-4-6",
  },
  minimax: {
    extensionId: "minimax",
    secretEnv: "MINIMAX_API_KEY",
    authChoice: "minimax-global-api",
    model: "minimax/MiniMax-M2.7",
  },
};

export function resolveProviderConfig(provider, env = process.env) {
  const config = providerConfig[provider];
  if (!config) {
    return null;
  }
  const providerEnvKey = `OPENCLAW_CROSS_OS_${provider.toUpperCase().replace(/[^A-Z0-9]+/gu, "_")}_MODEL`;
  const model = env[providerEnvKey]?.trim() || env.OPENCLAW_CROSS_OS_MODEL?.trim() || config.model;
  return { ...config, model };
}

const RELEASE_SMOKE_PLUGIN_ALLOWLIST_BASE = [
  "acpx",
  "bonjour",
  "browser",
  "device-pair",
  "phone-control",
  "talk-voice",
];

export function buildCrossOsReleaseSmokePluginAllowlist(providerMeta) {
  return [...new Set([providerMeta.extensionId, ...RELEASE_SMOKE_PLUGIN_ALLOWLIST_BASE])];
}

function shouldSeedProviderConfigModels(providerMeta) {
  return (
    typeof providerMeta.baseUrl === "string" || typeof providerMeta.timeoutSeconds === "number"
  );
}

function buildReleaseProviderConfigOverride(providerMeta) {
  if (!shouldSeedProviderConfigModels(providerMeta)) {
    return null;
  }
  return {
    ...(typeof providerMeta.baseUrl === "string" ? { baseUrl: providerMeta.baseUrl } : {}),
    models: [],
    ...(typeof providerMeta.timeoutSeconds === "number"
      ? { timeoutSeconds: providerMeta.timeoutSeconds }
      : {}),
  };
}

const PACKAGE_DIST_INVENTORY_RELATIVE_PATH = "dist/postinstall-inventory.json";
const OMITTED_QA_EXTENSION_PREFIXES = [
  "dist/extensions/qa-channel/",
  "dist/extensions/qa-lab/",
  "dist/extensions/qa-matrix/",
];
export const CROSS_OS_DASHBOARD_SMOKE_TIMEOUT_MS = 120_000;
export const CROSS_OS_DASHBOARD_FETCH_TIMEOUT_MS = 10_000;
export const CROSS_OS_GATEWAY_STATUS_RPC_TIMEOUT_MS = 30_000;
export const CROSS_OS_GATEWAY_STATUS_COMMAND_TIMEOUT_MS =
  CROSS_OS_GATEWAY_STATUS_RPC_TIMEOUT_MS + 45_000;
export const CROSS_OS_GATEWAY_READY_TIMEOUT_MS = 3 * 60_000;
export const CROSS_OS_WINDOWS_GATEWAY_READY_TIMEOUT_MS = 5 * 60_000;
export const CROSS_OS_RELEASE_SMOKE_TOOLS_PROFILE = "minimal";

if (isMainModule()) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${formatError(error)}\n`);
    process.exit(1);
  }
}

function isMainModule() {
  const invokedPath = process.argv[1]?.trim();
  if (!invokedPath) {
    return false;
  }
  return resolve(invokedPath) === SCRIPT_PATH;
}

export function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      continue;
    }
    const key = token.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) {
      parsed[key] = "true";
      continue;
    }
    parsed[key] = next;
    index += 1;
  }
  return parsed;
}

function parsePositiveIntegerEnv(name, fallback) {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer. Got: ${JSON.stringify(raw)}`);
  }
  return value;
}

function parseBooleanEnv(name, fallback) {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return fallback;
  }
  if (/^(1|true|yes|on)$/iu.test(raw)) {
    return true;
  }
  if (/^(0|false|no|off)$/iu.test(raw)) {
    return false;
  }
  throw new Error(`${name} must be a boolean. Got: ${JSON.stringify(raw)}`);
}

export function looksLikeReleaseVersionRef(ref) {
  const trimmed = normalizeRequestedRef(ref);
  return /^v?[0-9]{4}\.[0-9]+\.[0-9]+(?:-(?:[1-9][0-9]*)|[-.](?:alpha|beta|rc)[-.]?[0-9]+)?$/iu.test(
    trimmed,
  );
}

export function normalizeRequestedRef(ref) {
  const trimmed = ref?.trim() || "";
  if (!trimmed) {
    return "";
  }
  if (trimmed.startsWith("refs/heads/")) {
    return trimmed.slice("refs/heads/".length);
  }
  if (trimmed.startsWith("refs/tags/")) {
    return trimmed.slice("refs/tags/".length);
  }
  return trimmed;
}

export function isImmutableReleaseRef(ref) {
  const trimmed = ref?.trim() || "";
  return trimmed.startsWith("refs/tags/") || looksLikeReleaseVersionRef(trimmed);
}

export function resolveRequestedSuites(mode, ref) {
  if (!SUPPORTED_MODES.has(mode)) {
    throw new Error(`Unsupported mode "${mode}".`);
  }
  const suites = [];
  if (mode === "fresh" || mode === "both") {
    suites.push("packaged-fresh", "installer-fresh");
  }
  if (mode === "upgrade" || mode === "both") {
    suites.push("packaged-upgrade");
    if (shouldRunMainChannelDevUpdate(ref)) {
      suites.push("dev-update");
    }
  }
  return suites;
}

export function resolveRunnerMatrix(params) {
  const pick = (...values) =>
    values.find((value) => typeof value === "string" && value.trim().length > 0)?.trim();
  const suites = resolveRequestedSuites(params.mode, params.ref);
  const runners = [
    {
      os_id: "ubuntu",
      display_name: "Linux",
      runner: pick(params.ubuntuRunner, params.varUbuntuRunner, "blacksmith-8vcpu-ubuntu-2404"),
      artifact_name: "linux",
    },
    {
      os_id: "windows",
      display_name: "Windows",
      runner: pick(params.windowsRunner, params.varWindowsRunner, "blacksmith-32vcpu-windows-2025"),
      artifact_name: "windows",
    },
    {
      os_id: "macos",
      display_name: "macOS",
      runner: pick(params.macosRunner, params.varMacosRunner, "blacksmith-6vcpu-macos-latest"),
      artifact_name: "macos",
    },
  ];
  return {
    include: runners.flatMap((runner) =>
      suites.map((suite) =>
        Object.assign({}, runner, {
          suite,
          suite_label: formatSuiteLabel(suite),
          lane: suite.includes(`upgrade`) || suite === `dev-update` ? `upgrade` : `fresh`,
        }),
      ),
    ),
  };
}

export function readRunnerOverrideEnv(env = process.env) {
  const preferNonEmptyEnv = (primary: string | undefined, legacy: string | undefined) => {
    const primaryValue = primary?.trim();
    if (primaryValue) {
      return primaryValue;
    }
    const legacyValue = legacy?.trim();
    return legacyValue || "";
  };

  return {
    varUbuntuRunner: preferNonEmptyEnv(
      env.VAR_UBUNTU_RUNNER,
      env.OPENCLAW_RELEASE_CHECKS_UBUNTU_RUNNER,
    ),
    varWindowsRunner: preferNonEmptyEnv(
      env.VAR_WINDOWS_RUNNER,
      env.OPENCLAW_RELEASE_CHECKS_WINDOWS_RUNNER,
    ),
    varMacosRunner: preferNonEmptyEnv(
      env.VAR_MACOS_RUNNER,
      env.OPENCLAW_RELEASE_CHECKS_MACOS_RUNNER,
    ),
  };
}

function formatSuiteLabel(suite) {
  if (suite === "packaged-fresh") {
    return "packaged fresh";
  }
  if (suite === "installer-fresh") {
    return "installer fresh";
  }
  if (suite === "packaged-upgrade") {
    return "packaged upgrade";
  }
  return "dev update";
}

async function main(argv) {
  const args = parseArgs(argv);

  if (args["resolve-matrix"] === "true") {
    const mode = args["mode"] ?? "both";
    const ref = args["ref"]?.trim() || "main";
    const runnerOverrideEnv = readRunnerOverrideEnv(process.env);
    process.stdout.write(
      `${JSON.stringify(
        resolveRunnerMatrix({
          mode,
          ref,
          ubuntuRunner: args["ubuntu-runner"],
          windowsRunner: args["windows-runner"],
          macosRunner: args["macos-runner"],
          ...runnerOverrideEnv,
        }),
      )}\n`,
    );
    return;
  }

  const outputDir = resolve(requireArg(args, "output-dir"));
  const prepareOnly = args["prepare-only"] === "true";
  const sourceDir = args["source-dir"]?.trim() ? resolve(args["source-dir"].trim()) : "";
  const provider = args["provider"]?.trim() || "";
  const suite = args["suite"]?.trim() || "";
  const mode = args["mode"] ?? "both";
  const inputRef = args["ref"]?.trim() || "";
  const previousVersion = args["previous-version"]?.trim() || "";
  const baselineSpec =
    args["baseline-spec"]?.trim() ||
    (previousVersion ? `openclaw@${previousVersion}` : "openclaw@latest");
  const providedBaselineTgz = args["baseline-tgz"]?.trim()
    ? resolve(args["baseline-tgz"].trim())
    : "";
  const providedCandidateTgz = args["candidate-tgz"]?.trim()
    ? resolve(args["candidate-tgz"].trim())
    : "";
  const providedCandidateVersion = args["candidate-version"]?.trim() || "";
  const providedSourceSha = args["source-sha"]?.trim() || "";
  const runDiscordRoundtrip = args["run-discord-roundtrip"] === "true";

  mkdirSync(outputDir, { recursive: true });
  const logsDir = join(outputDir, "logs");
  mkdirSync(logsDir, { recursive: true });

  if (prepareOnly) {
    if (!sourceDir) {
      throw new Error("--prepare-only requires --source-dir.");
    }
    const build = await prepareCandidate({
      outputDir,
      sourceDir,
      logsDir,
    });
    writeCandidateManifest(outputDir, build);
    return;
  }

  if (!SUPPORTED_SUITES.has(suite)) {
    throw new Error(`Unsupported suite "${suite}".`);
  }
  if (!Object.hasOwn(providerConfig, provider)) {
    throw new Error(`Unsupported provider "${provider}".`);
  }

  const selectedProvider = resolveProviderConfig(provider);
  const providerSecretValue = process.env[selectedProvider.secretEnv]?.trim();
  if (!providerSecretValue) {
    throw new Error(`Missing ${selectedProvider.secretEnv}.`);
  }

  const summary = {
    platform: process.platform,
    runnerOs: process.env.OPENCLAW_RELEASE_CHECK_OS ?? "",
    runnerLabel: process.env.OPENCLAW_RELEASE_CHECK_RUNNER ?? "",
    provider,
    mode,
    suite,
    ref: inputRef || null,
    previousVersion: previousVersion || null,
    sourceDir,
    sourceSha: "",
    candidateVersion: "",
    candidateTgz: "",
    baselineSpec,
    result: {
      status: "pending",
    },
    discordRoundtrip: runDiscordRoundtrip,
  };

  let build;
  try {
    build = sourceDir
      ? await prepareCandidate({
          outputDir,
          sourceDir,
          logsDir,
        })
      : readProvidedCandidate({
          candidateTgz: providedCandidateTgz,
          candidateVersion: providedCandidateVersion,
          sourceSha: providedSourceSha,
        });
    summary.sourceSha = build.sourceSha;
    summary.candidateVersion = build.candidateVersion;
    summary.candidateTgz = build.candidateTgz;

    if (suite === "packaged-fresh") {
      summary.result = await runFreshLane({
        build,
        logsDir,
        providerConfig: selectedProvider,
        providerSecretValue,
      });
    } else if (suite === "packaged-upgrade") {
      const tgzServer = await startStaticFileServer({
        filePath: build.candidateTgz,
        logPath: join(logsDir, "candidate-http-server.log"),
      });
      try {
        summary.result = await runUpgradeLane({
          baselineSpec,
          baselineTgz: providedBaselineTgz,
          build,
          candidateUrl: tgzServer.url,
          logsDir,
          providerConfig: selectedProvider,
          providerSecretValue,
        });
      } finally {
        await tgzServer.close();
      }
    } else if (suite === "installer-fresh") {
      summary.result = await runInstallerFreshSuite({
        build,
        logsDir,
        providerConfig: selectedProvider,
        providerSecretValue,
        runDiscordRoundtrip,
      });
    } else {
      summary.result = await runDevUpdateSuite({
        baselineSpec,
        logsDir,
        providerConfig: selectedProvider,
        providerSecretValue,
        ref: inputRef || "main",
        sourceSha: build.sourceSha,
        runDiscordRoundtrip,
      });
    }
  } catch (error) {
    summary.result = {
      status: "fail",
      error: formatError(error),
    };
  }

  writeSummary(outputDir, summary);

  if (summary.result.status !== "pass") {
    process.exit(1);
  }
}

async function prepareCandidate(params) {
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
    NODE_OPTIONS: "--max-old-space-size=6144",
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
    logPath: join(params.logsDir, "npm-pack-dry-run.log"),
  });
  logPhase("prepare", "npm-pack");
  const packResult = await runCommand(
    npmCommand(),
    ["pack", "--ignore-scripts", "--json", "--pack-destination", packDir],
    {
      cwd: params.sourceDir,
      logPath: join(params.logsDir, "npm-pack.log"),
      timeoutMs: 10 * 60 * 1000,
    },
  );
  writeFileSync(packJsonPath, packResult.stdout, "utf8");
  const parsedPack = JSON.parse(packResult.stdout);
  const lastPack = Array.isArray(parsedPack) ? parsedPack.at(-1) : null;
  if (!lastPack?.filename) {
    throw new Error("npm pack did not report a filename.");
  }

  return {
    sourceDir: params.sourceDir,
    sourceSha,
    candidateVersion: String(lastPack.version ?? packageJson.version ?? "").trim(),
    candidateTgz: join(packDir, lastPack.filename),
    candidateFileName: String(lastPack.filename).trim(),
  };
}

function normalizeRelativePath(value) {
  return value.replace(/\\/gu, "/");
}

function isPackagedDistPath(relativePath) {
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

export async function writePackageDistInventoryForCandidate(params) {
  await assertNoLegacyPluginDependencyStagingDebris(params.sourceDir);
  const dryRun = await runCommand(
    npmCommand(),
    ["pack", "--dry-run", "--ignore-scripts", "--json"],
    {
      cwd: params.sourceDir,
      logPath: params.logPath,
      timeoutMs: 5 * 60 * 1000,
    },
  );
  const parsedPack = JSON.parse(dryRun.stdout);
  const lastPack = Array.isArray(parsedPack) ? parsedPack.at(-1) : null;
  const files = Array.isArray(lastPack?.files) ? lastPack.files : [];
  if (files.length === 0) {
    throw new Error(
      "npm pack --dry-run did not report package files for dist inventory generation.",
    );
  }
  const inventory = files
    .flatMap((entry) => {
      const relativePath = normalizeRelativePath(String(entry?.path ?? "").trim());
      return isPackagedDistPath(relativePath) ? [relativePath] : [];
    })
    .toSorted((left, right) => left.localeCompare(right));
  const inventoryPath = join(params.sourceDir, PACKAGE_DIST_INVENTORY_RELATIVE_PATH);
  mkdirSync(dirname(inventoryPath), { recursive: true });
  writeFileSync(inventoryPath, `${JSON.stringify(inventory, null, 2)}\n`, "utf8");
}

function readProvidedCandidate(params) {
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

async function runFreshLane(params) {
  const lane = createLaneState("fresh");
  const cleanup = [];
  try {
    const env = buildLaneEnv(lane, params.providerConfig, params.providerSecretValue);
    logLanePhase(lane, "install-candidate");
    await installTarballPackage({
      lane,
      env,
      tgzPath: params.build.candidateTgz,
      logPath: join(params.logsDir, "fresh-install.log"),
      restoreBundledPluginPostinstall: false,
    });
    const installed = readInstalledMetadata(lane.prefixDir);
    verifyInstalledCandidate(installed, params.build);
    logLanePhase(lane, "run-bundled-plugin-postinstall");
    await runBundledPluginPostinstall({
      lane,
      env,
      logPath: join(params.logsDir, "fresh-install.log"),
    });

    let browserOverrideImportStatus = "skipped";
    if (shouldRunWindowsInstalledBrowserOverrideImportSmoke()) {
      logLanePhase(lane, "windows-browser-override-import");
      browserOverrideImportStatus = await runInstalledBrowserOverrideImportSmoke({
        lane,
        env,
        prefixDir: lane.prefixDir,
        logPath: join(params.logsDir, "fresh-windows-browser-override-import.log"),
      });
    }

    logLanePhase(lane, "onboard");
    await runOnboard({
      lane,
      env,
      providerConfig: params.providerConfig,
      logPath: join(params.logsDir, "fresh-onboard.log"),
    });

    logLanePhase(lane, "models-set");
    await runModelsSet({
      lane,
      env,
      providerConfig: params.providerConfig,
      logPath: join(params.logsDir, "fresh-models-set.log"),
    });

    logLanePhase(lane, "start-gateway");
    const gateway = await startGateway({
      lane,
      env,
      logPath: join(params.logsDir, "fresh-gateway.log"),
    });
    cleanup.push(() => stopGateway(gateway));

    logLanePhase(lane, "wait-gateway");
    await waitForGateway({
      lane,
      env,
      logPath: join(params.logsDir, "fresh-gateway-status.log"),
    });

    logLanePhase(lane, "dashboard");
    await runDashboardSmoke({
      lane,
      logPath: join(params.logsDir, "fresh-dashboard.log"),
    });

    logLanePhase(lane, "agent-turn");
    const agent = await runAgentTurn({
      lane,
      env,
      label: "fresh",
      logPath: join(params.logsDir, "fresh-agent.log"),
    });

    return {
      status: "pass",
      installedVersion: installed.version,
      installedCommit: installed.commit,
      dashboardStatus: "pass",
      gatewayPort: lane.gatewayPort,
      browserOverrideImportStatus,
      agentOutput: trimForSummary(agent.stdout),
    };
  } finally {
    await runCleanup(cleanup);
  }
}

async function runUpgradeLane(params) {
  if (!params.baselineTgz && !params.baselineSpec) {
    throw new Error("Missing required --baseline-tgz argument for upgrade mode.");
  }
  if (!params.candidateUrl) {
    throw new Error("Missing candidate package URL for upgrade mode.");
  }
  const lane = createLaneState("upgrade");
  const cleanup = [];
  try {
    const env = buildLaneEnv(lane, params.providerConfig, params.providerSecretValue);
    logLanePhase(lane, "install-baseline");
    if (!params.baselineTgz && params.baselineSpec) {
      await installPackageSpec({
        lane,
        env,
        packageSpec: params.baselineSpec,
        logPath: join(params.logsDir, "upgrade-install-baseline.log"),
      });
    } else {
      await installTarballPackage({
        lane,
        env,
        tgzPath: params.baselineTgz,
        logPath: join(params.logsDir, "upgrade-install-baseline.log"),
        restoreBundledPluginPostinstall: false,
      });
    }
    logLanePhase(lane, "run-baseline-bundled-plugin-postinstall");
    await runBundledPluginPostinstall({
      lane,
      env,
      logPath: join(params.logsDir, "upgrade-install-baseline.log"),
    });

    const baseline = {
      version: readInstalledVersion(lane.prefixDir),
    };

    logLanePhase(lane, "update");
    const updateEnv = buildRealUpdateEnv(env);
    const updateArgs = [
      "update",
      "--tag",
      params.candidateUrl,
      "--yes",
      "--json",
      "--timeout",
      String(updateStepTimeoutSeconds()),
    ];
    const updateResult = await runOpenClaw({
      lane,
      env: updateEnv,
      args: updateArgs,
      logPath: join(params.logsDir, "upgrade-update.log"),
      timeoutMs: updateTimeoutMs(),
      check: false,
    });
    if (isRecoverableWindowsPackagedUpgradeSwapCleanupFailure(updateResult, process.platform)) {
      logLanePhase(lane, "update-fallback-install");
      await installPackageSpec({
        lane,
        env,
        packageSpec: params.candidateUrl,
        logPath: join(params.logsDir, "upgrade-update-fallback-install.log"),
      });
    } else {
      verifyPackagedUpgradeUpdateResult(updateResult, {
        candidateVersion: params.build.candidateVersion,
      });
    }

    logLanePhase(lane, "update-status");
    await runOpenClaw({
      lane,
      env: updateEnv,
      args: ["update", "status", "--json"],
      logPath: join(params.logsDir, "upgrade-update-status.log"),
      timeoutMs: 2 * 60 * 1000,
    });
    logLanePhase(lane, "run-bundled-plugin-postinstall");
    await runBundledPluginPostinstall({
      lane,
      env,
      logPath: join(params.logsDir, "upgrade-bundled-plugin-postinstall.log"),
    });

    const installed = readInstalledMetadata(lane.prefixDir);
    verifyInstalledCandidate(installed, params.build);

    logLanePhase(lane, "onboard");
    await runOnboard({
      lane,
      env,
      providerConfig: params.providerConfig,
      logPath: join(params.logsDir, "upgrade-onboard.log"),
    });

    logLanePhase(lane, "models-set");
    await runModelsSet({
      lane,
      env,
      providerConfig: params.providerConfig,
      logPath: join(params.logsDir, "upgrade-models-set.log"),
    });

    logLanePhase(lane, "start-gateway");
    const gateway = await startGateway({
      lane,
      env,
      logPath: join(params.logsDir, "upgrade-gateway.log"),
    });
    cleanup.push(() => stopGateway(gateway));

    logLanePhase(lane, "wait-gateway");
    await waitForGateway({
      lane,
      env,
      logPath: join(params.logsDir, "upgrade-gateway-status.log"),
    });

    logLanePhase(lane, "dashboard");
    await runDashboardSmoke({
      lane,
      logPath: join(params.logsDir, "upgrade-dashboard.log"),
    });

    logLanePhase(lane, "agent-turn");
    const agent = await runAgentTurn({
      lane,
      env,
      label: "upgrade",
      logPath: join(params.logsDir, "upgrade-agent.log"),
    });

    return {
      status: "pass",
      baselineVersion: baseline.version,
      installedVersion: installed.version,
      installedCommit: installed.commit,
      dashboardStatus: "pass",
      gatewayPort: lane.gatewayPort,
      agentOutput: trimForSummary(agent.stdout),
    };
  } finally {
    await runCleanup(cleanup);
  }
}

async function runInstallerFreshSuite(params) {
  const lane = createLaneState("installer-fresh");
  const cleanup = [];
  const usesManagedGateway = shouldUseManagedGatewayService();
  const useManagedGatewayAfterInstall = shouldUseManagedGatewayForInstallerRuntime();
  const manualGateway = { current: null };
  try {
    const env = buildInstallerEnv(lane, params.providerConfig, params.providerSecretValue);
    // Drive the public installer against the exact candidate artifact built from the requested ref.
    const candidateServer = await startStaticFileServer({
      filePath: params.build.candidateTgz,
      logPath: join(params.logsDir, "installer-candidate-http-server.log"),
    });
    cleanup.push(() => candidateServer.close());
    const installTarget = candidateServer.url;
    const installerUrl = resolvePublishedInstallerUrl();

    logLanePhase(lane, "installer-run");
    await runInstallerSmoke({
      lane,
      env,
      installerUrl,
      installTarget,
      logPath: join(params.logsDir, "installer-fresh-install.log"),
    });

    logLanePhase(lane, "fresh-shell");
    const freshShell = await verifyFreshShellCommand({
      lane,
      env,
      expectedNeedle: params.build.candidateVersion,
      logPath: join(params.logsDir, "installer-fresh-shell.log"),
    });
    const installed = readInstalledMetadataFromCliPath(freshShell.cliPath);
    verifyInstalledCandidate(installed, params.build);

    let browserOverrideImportStatus = "skipped";
    if (shouldRunWindowsInstalledBrowserOverrideImportSmoke()) {
      logLanePhase(lane, "windows-browser-override-import");
      browserOverrideImportStatus = await runInstalledBrowserOverrideImportSmoke({
        lane,
        env,
        prefixDir: resolveInstalledPrefixDirFromCliPath(freshShell.cliPath),
        logPath: join(params.logsDir, "installer-fresh-windows-browser-override-import.log"),
      });
    }

    logLanePhase(lane, "onboard");
    await runOnboardWithInstalledCli({
      lane,
      cliPath: freshShell.cliPath,
      env,
      providerConfig: params.providerConfig,
      installDaemon: usesManagedGateway,
      logPath: join(params.logsDir, "installer-fresh-onboard.log"),
    });

    if (shouldExerciseManagedGatewayLifecycleAfterInstall()) {
      await exerciseManagedGatewayLifecycle({
        lane,
        cliPath: freshShell.cliPath,
        env,
        logPrefix: join(params.logsDir, "installer-fresh-gateway"),
      });
    }

    logLanePhase(lane, "models-set");
    await runInstalledModelsSet({
      cliPath: freshShell.cliPath,
      env,
      providerConfig: params.providerConfig,
      cwd: lane.homeDir,
      logPath: join(params.logsDir, "installer-fresh-models-set.log"),
    });

    if (!useManagedGatewayAfterInstall) {
      // Keep the Windows installer lane validating Scheduled Task registration during
      // onboarding and lifecycle commands, but use a manual gateway for the runtime
      // checks after that so the installer validation does not depend on the more
      // failure-prone managed Windows session state for the remainder of the lane.
      if (shouldStopManagedGatewayBeforeManualFallback()) {
        logLanePhase(lane, "gateway-stop-managed");
        await runInstalledCli({
          cliPath: freshShell.cliPath,
          args: ["gateway", "stop"],
          env,
          cwd: lane.homeDir,
          logPath: join(params.logsDir, "installer-fresh-gateway-stop-managed.log"),
          timeoutMs: 2 * 60 * 1000,
          check: false,
        });
        await waitForInstalledGatewayToStop({
          lane,
          cliPath: freshShell.cliPath,
          env,
          logPath: join(params.logsDir, "installer-fresh-gateway-stop-managed-status.log"),
        });
      }
      logLanePhase(lane, "gateway-start");
      const gateway = await startManualGatewayFromInstalledCli({
        lane,
        cliPath: freshShell.cliPath,
        env,
        logPath: join(params.logsDir, "installer-fresh-gateway.log"),
      });
      manualGateway.current = gateway;
      cleanup.push(() => stopGateway(manualGateway.current));
      logLanePhase(lane, "gateway-status");
      await waitForInstalledGateway({
        lane,
        cliPath: freshShell.cliPath,
        env,
        logPath: join(params.logsDir, "installer-fresh-gateway-status.log"),
      });
    }

    logLanePhase(lane, "dashboard");
    await runDashboardSmoke({
      lane,
      logPath: join(params.logsDir, "installer-fresh-dashboard.log"),
    });

    logLanePhase(lane, "agent-turn");
    const agent = await runInstalledAgentTurn({
      cliPath: freshShell.cliPath,
      env,
      cwd: lane.homeDir,
      label: "installer-fresh",
      logPath: join(params.logsDir, "installer-fresh-agent.log"),
    });

    let discordStatus = "skipped";
    if (params.runDiscordRoundtrip && process.platform === "darwin") {
      logLanePhase(lane, "discord-roundtrip");
      discordStatus = await maybeRunDiscordRoundtrip({
        lane,
        cliPath: freshShell.cliPath,
        env,
        gatewayHolder: manualGateway,
        logPath: join(params.logsDir, "installer-fresh-discord.log"),
      });
    }

    return {
      status: "pass",
      installTarget,
      installVersion: installed.version,
      cliPath: freshShell.cliPath,
      installedVersion: installed.version,
      installedCommit: installed.commit,
      gatewayPort: lane.gatewayPort,
      dashboardStatus: "pass",
      browserOverrideImportStatus,
      discordStatus,
      agentOutput: trimForSummary(agent.stdout),
    };
  } finally {
    await runCleanup(cleanup);
  }
}

async function runDevUpdateSuite(params) {
  const lane = createLaneState("dev-update");
  const cleanup = [];
  const installTarget = await resolveInstallerTargetVersion({
    baselineSpec: params.baselineSpec,
    logsDir: params.logsDir,
    suiteName: "dev-update",
  });
  const usesManagedGateway = shouldUseManagedGatewayService();
  // Keep dev-update on a manual gateway even on Windows. The packaged lanes
  // already cover the Scheduled Task path, while repaired git installs live in
  // an ephemeral checkout that has proven flaky as a managed service in CI.
  const useManagedGatewayAfterDevUpdate = usesManagedGateway && process.platform !== "win32";
  const requestedRef = resolveExpectedDevUpdateRef(params.ref);
  if (!shouldRunMainChannelDevUpdate(requestedRef)) {
    throw new Error(
      `The dev-update suite only supports main. Received ${normalizeRequestedRef(params.ref) || "<empty>"}.`,
    );
  }
  const verificationRef = resolveDevUpdateVerificationRef(params.ref, params.sourceSha);
  const manualGateway = { current: null };
  try {
    const env = buildInstallerEnv(lane, params.providerConfig, params.providerSecretValue);
    const installerUrl = resolvePublishedInstallerUrl();

    logLanePhase(lane, "installer-baseline");
    await runInstallerSmoke({
      lane,
      env,
      installerUrl,
      installTarget,
      logPath: join(params.logsDir, "dev-update-install.log"),
    });

    logLanePhase(lane, "fresh-shell-baseline");
    const baselineShell = await verifyFreshShellCommand({
      lane,
      env,
      expectedNeedle: installTarget,
      logPath: join(params.logsDir, "dev-update-baseline-shell.log"),
    });

    logLanePhase(lane, "update-dev");
    await runInstalledCli({
      cliPath: baselineShell.cliPath,
      args: ["update", "--channel", "dev", "--yes", "--json"],
      env: {
        ...buildRealUpdateEnv(env),
        OPENCLAW_UPDATE_DEV_TARGET_REF: verificationRef,
      },
      cwd: lane.homeDir,
      logPath: join(params.logsDir, "dev-update.log"),
      timeoutMs: updateTimeoutMs(),
    });

    logLanePhase(lane, "fresh-shell-updated");
    const updatedShell = await verifyFreshShellCommand({
      lane,
      env,
      expectedNeedle: "OpenClaw",
      logPath: join(params.logsDir, "dev-update-shell.log"),
    });

    logLanePhase(lane, "update-status");
    const verifiedShell = await ensureDevUpdateGitInstall({
      lane,
      env,
      cliPath: updatedShell.cliPath,
      logsDir: params.logsDir,
      requestedRef: verificationRef,
    });

    if (process.platform === "win32") {
      logLanePhase(lane, "windows-toolchain");
      await verifyWindowsDevUpdateToolchain({
        lane,
        env,
        logPath: join(params.logsDir, "dev-update-windows-toolchain.log"),
      });
    }

    logLanePhase(lane, "onboard");
    await runOnboardWithInstalledCli({
      lane,
      cliPath: verifiedShell.cliPath,
      env,
      providerConfig: params.providerConfig,
      installDaemon: useManagedGatewayAfterDevUpdate,
      logPath: join(params.logsDir, "dev-update-onboard.log"),
    });

    logLanePhase(lane, "models-set");
    await runInstalledModelsSet({
      cliPath: verifiedShell.cliPath,
      env,
      providerConfig: params.providerConfig,
      cwd: lane.homeDir,
      logPath: join(params.logsDir, "dev-update-models-set.log"),
    });

    if (!useManagedGatewayAfterDevUpdate) {
      logLanePhase(lane, "gateway-start");
      const gateway = await startManualGatewayFromInstalledCli({
        lane,
        cliPath: verifiedShell.cliPath,
        env,
        logPath: join(params.logsDir, "dev-update-gateway.log"),
      });
      manualGateway.current = gateway;
      cleanup.push(() => stopGateway(manualGateway.current));
      logLanePhase(lane, "gateway-status");
      await waitForInstalledGateway({
        lane,
        cliPath: verifiedShell.cliPath,
        env,
        logPath: join(params.logsDir, "dev-update-gateway-status.log"),
      });
    } else {
      logLanePhase(lane, "gateway-ready");
      await ensureManagedGatewayReady({
        lane,
        cliPath: verifiedShell.cliPath,
        env,
        logPath: join(params.logsDir, "dev-update-gateway-ready.log"),
      });
    }

    logLanePhase(lane, "dashboard");
    await runDashboardSmoke({
      lane,
      logPath: join(params.logsDir, "dev-update-dashboard.log"),
    });

    logLanePhase(lane, "agent-turn");
    const agent = await runInstalledAgentTurn({
      cliPath: verifiedShell.cliPath,
      env,
      cwd: lane.homeDir,
      label: "dev-update",
      logPath: join(params.logsDir, "dev-update-agent.log"),
    });

    let discordStatus = "skipped";
    if (params.runDiscordRoundtrip && process.platform === "darwin") {
      logLanePhase(lane, "discord-roundtrip");
      discordStatus = await maybeRunDiscordRoundtrip({
        lane,
        cliPath: verifiedShell.cliPath,
        env,
        gatewayHolder: manualGateway,
        logPath: join(params.logsDir, "dev-update-discord.log"),
      });
    }

    return {
      status: "pass",
      installVersion: installTarget,
      cliPath: updatedShell.cliPath,
      gatewayPort: lane.gatewayPort,
      dashboardStatus: "pass",
      discordStatus,
      agentOutput: trimForSummary(agent.stdout),
    };
  } finally {
    await runCleanup(cleanup);
  }
}

function createLaneState(name) {
  const rootDir = mkdtempSync(join(tmpdir(), `openclaw-${name}-`));
  const prefixDir = join(rootDir, "prefix");
  const homeDir = join(rootDir, "home");
  const stateDir = join(homeDir, ".openclaw");
  const appDataDir = process.platform === "win32" ? join(homeDir, "AppData", "Roaming") : stateDir;
  mkdirSync(prefixDir, { recursive: true });
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(appDataDir, { recursive: true });
  if (process.platform !== "win32") {
    writeFileSync(join(homeDir, ".bashrc"), "", "utf8");
    writeFileSync(join(homeDir, ".zshrc"), "", "utf8");
  }
  return {
    name,
    rootDir,
    prefixDir,
    homeDir,
    stateDir,
    appDataDir,
    gatewayPort: 0,
  };
}

function buildLaneEnv(lane, providerMeta, providerSecretValue) {
  ensureLocalNpmShim(lane);
  return {
    ...process.env,
    HOME: lane.homeDir,
    USERPROFILE: lane.homeDir,
    APPDATA: lane.appDataDir,
    LOCALAPPDATA: join(lane.homeDir, "AppData", "Local"),
    OPENCLAW_HOME: lane.homeDir,
    OPENCLAW_STATE_DIR: lane.stateDir,
    OPENCLAW_CONFIG_PATH: join(lane.stateDir, "openclaw.json"),
    OPENCLAW_DISABLE_BONJOUR: "1",
    OPENCLAW_DISABLE_BUNDLED_PLUGIN_POSTINSTALL: "1",
    NPM_CONFIG_PREFIX: lane.prefixDir,
    PATH: `${binDirForPrefix(lane.prefixDir)}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}`,
    [providerMeta.secretEnv]: providerSecretValue,
  };
}

function buildInstallerEnv(lane, providerMeta, providerSecretValue) {
  const localAppData = join(lane.homeDir, "AppData", "Local");
  mkdirSync(localAppData, { recursive: true });
  return {
    ...process.env,
    HOME: lane.homeDir,
    USERPROFILE: lane.homeDir,
    APPDATA: lane.appDataDir,
    LOCALAPPDATA: localAppData,
    OPENCLAW_HOME: lane.homeDir,
    OPENCLAW_STATE_DIR: lane.stateDir,
    OPENCLAW_CONFIG_PATH: join(lane.stateDir, "openclaw.json"),
    OPENCLAW_DISABLE_BONJOUR: "1",
    OPENCLAW_NO_ONBOARD: "1",
    OPENCLAW_NO_PROMPT: "1",
    CI: "1",
    NODE_OPTIONS: "--max-old-space-size=6144",
    [providerMeta.secretEnv]: providerSecretValue,
  };
}

export function shouldUseManagedGatewayService(platform = process.platform) {
  return platform === "win32";
}

export function shouldUseManagedGatewayForInstallerRuntime(platform = process.platform) {
  return shouldUseManagedGatewayService(platform) && platform !== "win32";
}

export function shouldExerciseManagedGatewayLifecycleAfterInstall(platform = process.platform) {
  return shouldUseManagedGatewayService(platform);
}

export function shouldStopManagedGatewayBeforeManualFallback(platform = process.platform) {
  return shouldUseManagedGatewayService(platform);
}

function shouldRunBundledPluginPostinstall() {
  return true;
}

function looksLikeCommitSha(ref) {
  return /^[0-9a-f]{7,40}$/iu.test(ref.trim());
}

function resolveExpectedDevUpdateRef(ref) {
  const trimmed = normalizeRequestedRef(ref) || "main";
  return trimmed || "main";
}

export function resolveDevUpdateVerificationRef(ref, sourceSha) {
  if (resolveExpectedDevUpdateRef(ref) === "main" && looksLikeCommitSha(sourceSha ?? "")) {
    return sourceSha.trim();
  }
  return resolveExpectedDevUpdateRef(ref);
}

export function shouldRunMainChannelDevUpdate(ref) {
  if (isImmutableReleaseRef(ref)) {
    return false;
  }
  return resolveExpectedDevUpdateRef(ref) === "main";
}

export function shouldSkipInstallerDaemonHealthCheck(platform = process.platform) {
  return platform === "win32";
}

export function buildRealUpdateEnv(env) {
  const updateEnv = {
    ...env,
    NODE_DISABLE_COMPILE_CACHE: "1",
  };
  delete updateEnv.OPENCLAW_DISABLE_BUNDLED_PLUGIN_POSTINSTALL;
  delete updateEnv.NODE_COMPILE_CACHE;
  return updateEnv;
}

export function verifyPackagedUpgradeUpdateResult(result, _options) {
  if (result.exitCode === 0) {
    return;
  }

  throw new Error(
    `Packaged upgrade failed (${result.exitCode}): ${trimForSummary(
      `${result.stdout}\n${result.stderr}`,
    )}`,
  );
}

export function isRecoverableWindowsPackagedUpgradeSwapCleanupFailure(
  result,
  platform = process.platform,
) {
  if (platform !== "win32" || result.exitCode === 0) {
    return false;
  }
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  return (
    /\bglobal install swap\b/iu.test(output) &&
    /\bEPERM\b/iu.test(output) &&
    /\bunlink\b/iu.test(output) &&
    /[/\\]\.openclaw-\d+-\d+[/\\]/u.test(output) &&
    /\.node['"]?/iu.test(output)
  );
}

export function resolveExplicitBaselineVersion(baselineSpec) {
  const trimmed = baselineSpec.trim();
  if (!trimmed || trimmed === "openclaw@latest") {
    return "";
  }
  if (trimmed.startsWith("openclaw@")) {
    return trimmed.slice("openclaw@".length);
  }
  return trimmed;
}

async function resolveInstallerTargetVersion(params) {
  const resolvedVersion = resolveExplicitBaselineVersion(params.baselineSpec);
  if (resolvedVersion) {
    return resolvedVersion;
  }
  const latestResult = await runCommand(npmCommand(), ["view", "openclaw@latest", "version"], {
    logPath: join(params.logsDir, `${params.suiteName}-latest-version.log`),
    timeoutMs: 2 * 60 * 1000,
  });
  const latestVersion = latestResult.stdout.trim();
  if (!latestVersion) {
    throw new Error("npm view openclaw@latest version did not return a version.");
  }
  return latestVersion;
}

function powerShellSingleQuote(value) {
  return value.replace(/'/gu, "''");
}

function readPackageJson(packageRoot) {
  return JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
}

function packageJsonHasScript(packageJson, scriptName) {
  return typeof packageJson?.scripts?.[scriptName] === "string";
}

export function packageHasScript(packageRoot, scriptName) {
  try {
    return packageJsonHasScript(readPackageJson(packageRoot), scriptName);
  } catch {
    return false;
  }
}

function parseMarkerLine(output, marker) {
  return `${output}`
    .split(/\r?\n/gu)
    .find((line) => line.startsWith(marker))
    ?.slice(marker.length)
    .trim();
}

export function normalizeWindowsInstalledCliPath(cliPath) {
  return normalizeWindowsCommandShimPath(cliPath);
}

export function normalizeWindowsCommandShimPath(commandPath) {
  if (typeof commandPath !== "string") {
    return commandPath;
  }
  return commandPath.replace(/\.ps1$/iu, ".cmd");
}

export function resolveInstalledPrefixDirFromCliPath(cliPath, platform = process.platform) {
  const resolvedCliPath =
    platform === "win32" ? normalizeWindowsInstalledCliPath(cliPath) : String(cliPath ?? "");
  if (!resolvedCliPath?.trim()) {
    throw new Error("Missing installed CLI path.");
  }
  if (platform === "win32") {
    return pathWin32.dirname(resolvedCliPath);
  }
  return dirname(dirname(resolvedCliPath));
}

function readInstalledMetadataFromCliPath(cliPath, platform = process.platform) {
  return readInstalledMetadataFromPackageRoot(
    resolveInstalledPackageRootFromCliPath(cliPath, platform),
  );
}

function resolveInstalledCliInvocation(cliPath, platform = process.platform) {
  if (platform !== "win32") {
    return { command: cliPath, argsPrefix: [], shell: false };
  }
  const normalizedCliPath = normalizeWindowsInstalledCliPath(cliPath);
  if (!/\.cmd$/iu.test(normalizedCliPath)) {
    return { command: normalizedCliPath, argsPrefix: [], shell: false };
  }
  const entryPath = installedEntryPath(
    resolveInstalledPrefixDirFromCliPath(normalizedCliPath, platform),
  );
  if (existsSync(entryPath)) {
    return {
      command: process.execPath,
      argsPrefix: [entryPath],
      shell: false,
    };
  }
  return { command: normalizedCliPath, argsPrefix: [], shell: true };
}

async function runPosixShellScript(script, options) {
  return runCommand("/bin/bash", ["-lc", script], options);
}

async function runPowerShellScript(script, options) {
  return runCommand(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
    options,
  );
}

async function runInstallerSmoke(params) {
  if (process.platform === "win32") {
    const script = `
$response = Invoke-WebRequest -UseBasicParsing '${powerShellSingleQuote(params.installerUrl)}'
$content = $response.Content
if ($content -is [byte[]]) {
  $content = [System.Text.Encoding]::UTF8.GetString($content)
}
& ([scriptblock]::Create([string]$content)) -Tag '${powerShellSingleQuote(params.installTarget)}' -NoOnboard
`;
    await runPowerShellScript(script, {
      cwd: params.lane.homeDir,
      env: params.env,
      logPath: params.logPath,
      timeoutMs: installTimeoutMs(),
    });
    return;
  }

  const script = [
    "set -euo pipefail",
    `curl -fsSL '${shellEscapeForSh(params.installerUrl)}' | bash -s -- --version '${shellEscapeForSh(params.installTarget)}' --no-onboard`,
  ].join("\n");
  await runPosixShellScript(script, {
    cwd: params.lane.homeDir,
    env: params.env,
    logPath: params.logPath,
    timeoutMs: installTimeoutMs(),
  });
}

export function buildWindowsPathBootstrapScript(options = {}) {
  const includeCurrentProcessPath = options.includeCurrentProcessPath !== false;
  const pathCandidates = includeCurrentProcessPath
    ? "@($userPath, $machinePath, $env:Path)"
    : "@($userPath, $machinePath)";
  return `
$machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
$segments = New-Object System.Collections.Generic.List[string]
foreach ($candidate in ${pathCandidates}) {
  foreach ($segment in ($candidate -split ';')) {
    if ([string]::IsNullOrWhiteSpace($segment)) {
      continue
    }
    if (-not $segments.Contains($segment)) {
      $segments.Add($segment)
    }
  }
}
$env:Path = [string]::Join(';', $segments)
`.trim();
}

export function buildWindowsFreshShellVersionCheckScript(params = {}) {
  const expectedNeedle = powerShellSingleQuote(params.expectedNeedle ?? "");
  return `
${buildWindowsPathBootstrapScript()}
$commandPath = $null
$npmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue
if ($null -eq $npmCommand) {
  $npmCommand = Get-Command npm -ErrorAction SilentlyContinue
}
if ($null -ne $npmCommand) {
  $npmPrefix = (& $npmCommand.Source config get prefix 2>$null | Out-String).Trim()
  if (-not [string]::IsNullOrWhiteSpace($npmPrefix)) {
    $env:Path = "$npmPrefix;$env:Path"
    foreach ($candidate in @(
      (Join-Path $npmPrefix 'openclaw.cmd'),
      (Join-Path $npmPrefix 'openclaw.ps1')
    )) {
      if (Test-Path -LiteralPath $candidate) {
        $commandPath = $candidate
        break
      }
    }
  }
}
if ([string]::IsNullOrWhiteSpace($commandPath)) {
  $cmd = Get-Command openclaw -ErrorAction Stop
  $commandPath = $cmd.Source
}
if ($commandPath -match '(?i)\\.ps1$') {
  $cmdPath = [System.IO.Path]::ChangeExtension($commandPath, '.cmd')
  if (Test-Path -LiteralPath $cmdPath) {
    $commandPath = $cmdPath
  }
}
$version = (& $commandPath --version 2>&1 | Out-String).Trim()
Write-Output "__OPENCLAW_PATH__=$commandPath"
Write-Output $version
if ('${expectedNeedle}'.Length -gt 0 -and $version -notmatch [regex]::Escape('${expectedNeedle}')) {
  throw "version mismatch: expected substring ${expectedNeedle}"
}
`.trim();
}

export function buildWindowsDevUpdateToolchainCheckScript() {
  return `
${buildWindowsPathBootstrapScript()}
function Resolve-CommandPath([string]$Name) {
  $command = Get-Command $Name -ErrorAction SilentlyContinue
  if ($null -eq $command) {
    return $null
  }
  $commandPath = $command.Source
  if ($commandPath -match '(?i)\\.ps1$') {
    $cmdPath = [System.IO.Path]::ChangeExtension($commandPath, '.cmd')
    if (Test-Path -LiteralPath $cmdPath) {
      $commandPath = $cmdPath
    }
  }
  return $commandPath
}
$pnpmPath = Resolve-CommandPath 'pnpm'
if ($null -ne $pnpmPath) {
  Write-Output "__UPDATE_TOOL__=pnpm"
  Write-Output "__UPDATE_TOOL_PATH__=$pnpmPath"
  & $pnpmPath --version
  return
}
$corepackPath = Resolve-CommandPath 'corepack'
if ($null -ne $corepackPath) {
  Write-Output "__UPDATE_TOOL__=corepack"
  Write-Output "__UPDATE_TOOL_PATH__=$corepackPath"
  & $corepackPath --version
  return
}
$npmPath = Resolve-CommandPath 'npm'
if ($null -ne $npmPath) {
  Write-Output "__UPDATE_TOOL__=npm"
  Write-Output "__UPDATE_TOOL_PATH__=$npmPath"
  & $npmPath --version
  return
}
throw 'Neither pnpm, corepack, nor npm is discoverable from the reconstructed Windows PATH.'
`.trim();
}

async function verifyFreshShellCommand(params) {
  if (process.platform === "win32") {
    const script = buildWindowsFreshShellVersionCheckScript({
      expectedNeedle: params.expectedNeedle,
    });
    const result = await runPowerShellScript(script, {
      cwd: params.lane.homeDir,
      env: params.env,
      logPath: params.logPath,
      timeoutMs: 2 * 60 * 1000,
    });
    const cliPath = normalizeWindowsInstalledCliPath(
      parseMarkerLine(result.stdout, "__OPENCLAW_PATH__="),
    );
    if (!cliPath) {
      throw new Error("Failed to resolve installed openclaw path from fresh Windows shell.");
    }
    return {
      cliPath,
      versionOutput: `${result.stdout}\n${result.stderr}`.trim(),
    };
  }

  const script = [
    "set -euo pipefail",
    'if [ -f "$HOME/.bashrc" ]; then . "$HOME/.bashrc"; fi',
    "command -v openclaw >/dev/null 2>&1",
    'printf "__OPENCLAW_PATH__=%s\\n" "$(command -v openclaw)"',
    "openclaw --version",
  ].join("\n");
  const result = await runPosixShellScript(script, {
    cwd: params.lane.homeDir,
    env: params.env,
    logPath: params.logPath,
    timeoutMs: 2 * 60 * 1000,
  });
  const cliPath = parseMarkerLine(result.stdout, "__OPENCLAW_PATH__=");
  const versionOutput = `${result.stdout}\n${result.stderr}`.trim();
  if (!cliPath) {
    throw new Error("Failed to resolve installed openclaw path from fresh POSIX shell.");
  }
  if (params.expectedNeedle && !versionOutput.includes(params.expectedNeedle)) {
    throw new Error(
      `Installed CLI version did not contain expected substring ${params.expectedNeedle}.`,
    );
  }
  return { cliPath, versionOutput };
}

async function runInstalledCli(params) {
  const invocation = resolveInstalledCliInvocation(params.cliPath);
  return runCommand(invocation.command, [...invocation.argsPrefix, ...params.args], {
    cwd: params.cwd,
    env: params.env,
    logPath: params.logPath,
    timeoutMs: params.timeoutMs,
    check: params.check ?? true,
  });
}

async function readInstalledUpdateStatus(params) {
  return runInstalledCli({
    cliPath: params.cliPath,
    args: ["update", "status", "--json"],
    cwd: params.cwd,
    env: params.env,
    logPath: params.logPath,
    timeoutMs: 2 * 60 * 1000,
  });
}

async function ensureDevUpdateGitInstall(params) {
  const updateStatus = await readInstalledUpdateStatus({
    cliPath: params.cliPath,
    cwd: params.lane.homeDir,
    env: params.env,
    logPath: join(params.logsDir, "dev-update-status.log"),
  });
  // The dev-update lane must prove that `openclaw update --channel dev` landed on
  // the expected git checkout. Falling back to a manual repair here would hide
  // updater regressions and turn the suite into a false green.
  verifyDevUpdateStatus(updateStatus.stdout, { ref: params.requestedRef });
  return { cliPath: params.cliPath };
}

async function runOnboardWithInstalledCli(params) {
  await withAllocatedGatewayPort(params.lane, async () => {
    const args = buildReleaseOnboardArgs({
      authChoice: params.providerConfig.authChoice,
      gatewayPort: params.lane.gatewayPort,
      installDaemon: params.installDaemon,
      skipHealth: !params.installDaemon || shouldSkipInstallerDaemonHealthCheck(),
    });
    await runInstalledCli({
      cliPath: params.cliPath,
      args,
      cwd: params.lane.homeDir,
      env: params.env,
      logPath: params.logPath,
      timeoutMs: 10 * 60 * 1000,
    });
  });
}

export function buildReleaseOnboardArgs(params) {
  const args = [
    "onboard",
    "--non-interactive",
    "--mode",
    "local",
    "--auth-choice",
    params.authChoice,
    "--secret-input-mode",
    "ref",
    "--gateway-port",
    String(params.gatewayPort),
    "--gateway-bind",
    "loopback",
    "--skip-skills",
    "--skip-bootstrap",
    "--accept-risk",
    "--json",
  ];
  if (params.installDaemon) {
    args.push("--install-daemon");
  }
  if (params.skipHealth) {
    args.push("--skip-health");
  }
  return args;
}

async function startManualGatewayFromInstalledCli(params) {
  mkdirSync(dirname(params.logPath), { recursive: true });
  const gatewayLog = createWriteStream(params.logPath, { flags: "a" });
  const invocation = resolveInstalledCliInvocation(params.cliPath);
  const child = spawn(
    invocation.command,
    [
      ...invocation.argsPrefix,
      "gateway",
      "run",
      "--bind",
      "loopback",
      "--port",
      String(params.lane.gatewayPort),
      "--force",
    ],
    {
      cwd: params.lane.homeDir,
      env: params.env,
      shell: invocation.shell,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  child.stdout?.on("data", (chunk) => {
    gatewayLog.write(chunk);
  });
  child.stderr?.on("data", (chunk) => {
    gatewayLog.write(chunk);
  });
  let logClosed = false;
  const closeLog = async () => {
    if (logClosed) {
      return;
    }
    logClosed = true;
    await new Promise((resolvePromise) => {
      gatewayLog.once("error", () => resolvePromise());
      gatewayLog.end(() => resolvePromise());
    });
  };
  child.once("close", () => {
    void closeLog();
  });
  child.once("error", () => {
    void closeLog();
  });
  return { child, closeLog, logPath: params.logPath };
}

async function resolveInstalledGatewayStatusArgs(params) {
  const requireRpc = params.requireRpc !== false;
  const help = await runInstalledCli({
    cliPath: params.cliPath,
    args: ["gateway", "status", "--help"],
    cwd: params.cwd,
    env: params.env,
    logPath: params.logPath,
    timeoutMs: 15_000,
    check: false,
  });
  if (
    requireRpc &&
    (help.stdout.includes("--require-rpc") || help.stderr.includes("--require-rpc"))
  ) {
    return [
      "gateway",
      "status",
      "--require-rpc",
      "--timeout",
      String(CROSS_OS_GATEWAY_STATUS_RPC_TIMEOUT_MS),
    ];
  }
  return ["gateway", "status"];
}

export async function canConnectToLoopbackPort(port, timeoutMs = 1_000) {
  if (!Number.isInteger(port) || port <= 0) {
    return false;
  }
  return await new Promise((resolvePromise) => {
    let settled = false;
    const socket = createNetConnection({
      host: "127.0.0.1",
      port,
    });
    const settle = (value) => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      resolvePromise(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => settle(true));
    socket.once("timeout", () => settle(false));
    socket.once("error", () => settle(false));
  });
}

async function waitForInstalledGateway(params) {
  const statusArgs = await resolveInstalledGatewayStatusArgs({
    cliPath: params.cliPath,
    cwd: params.lane.homeDir,
    env: params.env,
    logPath: params.logPath,
  });
  const deadline = Date.now() + gatewayReadyDeadlineMs();
  while (Date.now() < deadline) {
    const result = await runInstalledCli({
      cliPath: params.cliPath,
      args: statusArgs,
      cwd: params.lane.homeDir,
      env: params.env,
      logPath: params.logPath,
      timeoutMs: CROSS_OS_GATEWAY_STATUS_COMMAND_TIMEOUT_MS,
      check: false,
    });
    if (result.exitCode === 0) {
      return;
    }
    await sleep(2_000);
  }
  throw new Error(`Gateway did not become ready on port ${params.lane.gatewayPort}.`);
}

async function waitForInstalledGatewayToStop(params) {
  const statusArgs = await resolveInstalledGatewayStatusArgs({
    cliPath: params.cliPath,
    cwd: params.lane.homeDir,
    env: params.env,
    logPath: params.logPath,
    requireRpc: false,
  });
  const deadline = Date.now() + gatewayReadyDeadlineMs();
  while (Date.now() < deadline) {
    await runInstalledCli({
      cliPath: params.cliPath,
      args: statusArgs,
      cwd: params.lane.homeDir,
      env: params.env,
      logPath: params.logPath,
      timeoutMs: CROSS_OS_GATEWAY_STATUS_COMMAND_TIMEOUT_MS,
      check: false,
    });
    const portReachable = await canConnectToLoopbackPort(params.lane.gatewayPort);
    if (!portReachable) {
      return;
    }
    await sleep(2_000);
  }
  throw new Error(
    `Managed gateway did not stop on port ${params.lane.gatewayPort} before manual fallback.`,
  );
}

async function ensureManagedGatewayReady(params) {
  try {
    await waitForInstalledGateway(params);
    return;
  } catch {
    await runInstalledCli({
      cliPath: params.cliPath,
      args: ["gateway", "start"],
      cwd: params.lane.homeDir,
      env: params.env,
      logPath: params.logPath,
      timeoutMs: 2 * 60 * 1000,
      check: false,
    });
  }
  await waitForInstalledGateway(params);
}

async function runInstalledModelsSet(params) {
  await runInstalledCli({
    cliPath: params.cliPath,
    args: ["models", "set", params.providerConfig.model],
    cwd: params.cwd,
    env: params.env,
    logPath: params.logPath,
    timeoutMs: 2 * 60 * 1000,
  });
  const providerConfigOverride = buildReleaseProviderConfigOverride(params.providerConfig);
  if (providerConfigOverride) {
    await runInstalledCli({
      cliPath: params.cliPath,
      args: [
        "config",
        "set",
        `models.providers.${params.providerConfig.extensionId}`,
        JSON.stringify(providerConfigOverride),
        "--strict-json",
        "--merge",
      ],
      cwd: params.cwd,
      env: params.env,
      logPath: params.logPath,
      timeoutMs: 2 * 60 * 1000,
    });
  }
  await runInstalledCli({
    cliPath: params.cliPath,
    args: [
      "config",
      "set",
      "plugins.allow",
      JSON.stringify(buildCrossOsReleaseSmokePluginAllowlist(params.providerConfig)),
      "--strict-json",
    ],
    cwd: params.cwd,
    env: params.env,
    logPath: params.logPath,
    timeoutMs: 2 * 60 * 1000,
  });
  await runInstalledCli({
    cliPath: params.cliPath,
    args: ["config", "set", "agents.defaults.skipBootstrap", "true", "--strict-json"],
    cwd: params.cwd,
    env: params.env,
    logPath: params.logPath,
    timeoutMs: 2 * 60 * 1000,
  });
  await runInstalledCli({
    cliPath: params.cliPath,
    args: ["config", "set", "tools.profile", CROSS_OS_RELEASE_SMOKE_TOOLS_PROFILE],
    cwd: params.cwd,
    env: params.env,
    logPath: params.logPath,
    timeoutMs: 2 * 60 * 1000,
  });
}

async function runInstalledAgentTurn(params) {
  let lastError;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const sessionId = `cross-os-release-check-${params.label}-${Date.now()}-${attempt}`;
    try {
      const result = await runInstalledCli({
        cliPath: params.cliPath,
        args: buildReleaseAgentTurnArgs(sessionId),
        cwd: params.cwd,
        env: params.env,
        logPath: params.logPath,
        timeoutMs: (CROSS_OS_AGENT_TURN_TIMEOUT_SECONDS + 60) * 1000,
      });
      if (!agentOutputHasExpectedOkMarker(result.stdout, { logPath: params.logPath })) {
        throw new Error("Agent output did not contain the expected OK marker.");
      }
      return result;
    } catch (error) {
      lastError = error;
      const skipped = maybeBuildOptionalAgentTurnSkipResult(error, params.logPath);
      if (skipped) {
        return skipped;
      }
      if (attempt >= 2 || !shouldRetryCrossOsAgentTurnError(error)) {
        throw error;
      }
      appendFileSync(
        params.logPath,
        `\n[release-checks] retrying installed agent turn after retryable live failure: ${
          error instanceof Error ? error.message : String(error)
        }\n`,
      );
    }
  }
  throw lastError;
}

export function verifyDevUpdateStatus(stdout, options = {}) {
  let payload = null;
  try {
    payload = JSON.parse(stdout);
  } catch {
    payload = null;
  }
  const expectedRef = resolveExpectedDevUpdateRef(options.ref);
  const update = payload?.update ?? payload;
  const installKind = update?.installKind ?? null;
  const branch = update?.git?.branch ?? null;
  const sha = update?.git?.sha ?? null;
  const channelValue = payload?.channel?.value ?? payload?.channel?.channel ?? null;
  if (installKind !== "git") {
    throw new Error(
      `Dev update did not land on a git install. Found ${installKind ?? "<missing>"}.`,
    );
  }
  if (channelValue !== "dev") {
    throw new Error(
      `Dev update status did not report channel=dev. Found ${channelValue ?? "<missing>"}.`,
    );
  }
  if (looksLikeCommitSha(expectedRef)) {
    const normalizedSha = typeof sha === "string" ? sha.toLowerCase() : "";
    const normalizedExpectedRef = expectedRef.toLowerCase();
    if (!normalizedSha || !normalizedSha.startsWith(normalizedExpectedRef)) {
      throw new Error(
        `Dev update status did not report sha=${expectedRef}. Found ${sha ?? "<missing>"}.`,
      );
    }
    return;
  }
  if (branch !== expectedRef) {
    throw new Error(
      `Dev update status did not report branch=${expectedRef}. Found ${branch ?? "<missing>"}.`,
    );
  }
}

async function verifyWindowsDevUpdateToolchain(params) {
  const script = buildWindowsDevUpdateToolchainCheckScript();
  const result = await runPowerShellScript(script, {
    cwd: params.lane.homeDir,
    env: params.env,
    logPath: params.logPath,
    timeoutMs: 2 * 60 * 1000,
  });
  if (!parseMarkerLine(result.stdout, "__UPDATE_TOOL__=")) {
    throw new Error(
      "No Windows update bootstrap tool (pnpm, corepack, or npm) was discoverable after the dev update.",
    );
  }
}

export function buildDiscordSmokeGuildsConfig(guildId, channelId) {
  return {
    [guildId]: {
      channels: {
        [channelId]: {
          enabled: true,
          requireMention: false,
        },
      },
    },
  };
}

async function configureDiscordSmoke(params) {
  const guildsJson = JSON.stringify(
    buildDiscordSmokeGuildsConfig(params.guildId, params.channelId),
  );
  await runInstalledCli({
    cliPath: params.cliPath,
    args: [
      "config",
      "set",
      "channels.discord.token",
      "--ref-provider",
      "default",
      "--ref-source",
      "env",
      "--ref-id",
      "DISCORD_BOT_TOKEN",
    ],
    cwd: params.cwd,
    env: { ...params.env, DISCORD_BOT_TOKEN: params.token },
    logPath: params.logPath,
    timeoutMs: 2 * 60 * 1000,
  });
  await runInstalledCli({
    cliPath: params.cliPath,
    args: ["config", "set", "channels.discord.enabled", "true"],
    cwd: params.cwd,
    env: params.env,
    logPath: params.logPath,
    timeoutMs: 2 * 60 * 1000,
  });
  await runInstalledCli({
    cliPath: params.cliPath,
    args: ["config", "set", "channels.discord.groupPolicy", "allowlist"],
    cwd: params.cwd,
    env: params.env,
    logPath: params.logPath,
    timeoutMs: 2 * 60 * 1000,
  });
  await runInstalledCli({
    cliPath: params.cliPath,
    args: ["config", "set", "channels.discord.guilds", guildsJson, "--strict-json"],
    cwd: params.cwd,
    env: params.env,
    logPath: params.logPath,
    timeoutMs: 2 * 60 * 1000,
  });
  if (!shouldUseManagedGatewayService()) {
    const gatewayEnv = { ...params.env, DISCORD_BOT_TOKEN: params.token };
    if (params.gatewayHolder?.current) {
      await stopGateway(params.gatewayHolder.current);
      params.gatewayHolder.current = null;
    }
    const gateway = await startManualGatewayFromInstalledCli({
      lane: params.lane,
      cliPath: params.cliPath,
      env: gatewayEnv,
      logPath: join(params.cwd, `.openclaw/logs/${params.lane.name}-discord-gateway.log`),
    });
    if (params.gatewayHolder) {
      params.gatewayHolder.current = gateway;
    }
    await waitForInstalledGateway({
      lane: params.lane,
      cliPath: params.cliPath,
      env: gatewayEnv,
      logPath: params.logPath,
    });
    return;
  }
  await runInstalledCli({
    cliPath: params.cliPath,
    args: ["gateway", "restart"],
    cwd: params.cwd,
    env: { ...params.env, DISCORD_BOT_TOKEN: params.token },
    logPath: params.logPath,
    timeoutMs: 2 * 60 * 1000,
    check: false,
  });
  await ensureManagedGatewayReady({
    lane: params.lane,
    cliPath: params.cliPath,
    env: { ...params.env, DISCORD_BOT_TOKEN: params.token },
    logPath: params.logPath,
  });
}

async function waitForDiscordMessage(params) {
  const deadline = Date.now() + 3 * 60 * 1000;
  while (Date.now() < deadline) {
    const response = await fetch(
      `https://discord.com/api/v10/channels/${params.channelId}/messages?limit=20`,
      {
        headers: {
          Authorization: `Bot ${params.token}`,
        },
      },
    );
    const text = await response.text();
    if (!response.ok) {
      await sleep(2_000);
      continue;
    }
    if (text.includes(params.needle)) {
      return;
    }
    await sleep(2_000);
  }
  throw new Error(`Discord host-side visibility check timed out for ${params.needle}.`);
}

async function postDiscordMessage(params) {
  const response = await fetch(
    `https://discord.com/api/v10/channels/${params.channelId}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bot ${params.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        content: params.content,
        flags: 4096,
      }),
    },
  );
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Failed to post Discord smoke message: ${text}`);
  }
  try {
    return JSON.parse(text)?.id ?? null;
  } catch {
    return null;
  }
}

async function deleteDiscordMessage(params) {
  if (!params.messageId) {
    return;
  }
  await fetch(
    `https://discord.com/api/v10/channels/${params.channelId}/messages/${params.messageId}`,
    {
      method: "DELETE",
      headers: {
        Authorization: `Bot ${params.token}`,
      },
    },
  ).catch(() => undefined);
}

async function waitForInstalledDiscordReadback(params) {
  const deadline = Date.now() + 3 * 60 * 1000;
  while (Date.now() < deadline) {
    const response = await runInstalledCli({
      cliPath: params.cliPath,
      args: [
        "message",
        "read",
        "--channel",
        "discord",
        "--target",
        `channel:${params.channelId}`,
        "--limit",
        "20",
        "--json",
      ],
      cwd: params.cwd,
      env: params.env,
      logPath: params.logPath,
      timeoutMs: 60_000,
      check: false,
    });
    if (response.exitCode === 0 && response.stdout.includes(params.needle)) {
      return;
    }
    await sleep(3_000);
  }
  throw new Error(`Discord guest readback timed out for ${params.needle}.`);
}

async function maybeRunDiscordRoundtrip(params) {
  const token =
    process.env.OPENCLAW_DISCORD_SMOKE_BOT_TOKEN?.trim() ||
    process.env.DISCORD_BOT_TOKEN?.trim() ||
    "";
  const guildId = process.env.OPENCLAW_DISCORD_SMOKE_GUILD_ID?.trim() || "";
  const channelId = process.env.OPENCLAW_DISCORD_SMOKE_CHANNEL_ID?.trim() || "";
  if (!token || !guildId || !channelId) {
    return "skipped-missing-config";
  }

  const outboundNonce = `native-cross-os-outbound-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const inboundNonce = `native-cross-os-inbound-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  let sentMessageId = null;
  let hostMessageId = null;
  try {
    await configureDiscordSmoke({
      lane: params.lane,
      cliPath: params.cliPath,
      cwd: params.lane.homeDir,
      env: params.env,
      gatewayHolder: params.gatewayHolder,
      logPath: params.logPath,
      token,
      guildId,
      channelId,
    });

    const sendResult = await runInstalledCli({
      cliPath: params.cliPath,
      args: [
        "message",
        "send",
        "--channel",
        "discord",
        "--target",
        `channel:${channelId}`,
        "--message",
        outboundNonce,
        "--silent",
        "--json",
      ],
      cwd: params.lane.homeDir,
      env: { ...params.env, DISCORD_BOT_TOKEN: token },
      logPath: params.logPath,
      timeoutMs: 2 * 60 * 1000,
    });
    let parsedSendResult = null;
    try {
      parsedSendResult = JSON.parse(sendResult.stdout);
    } catch {
      parsedSendResult = null;
    }
    sentMessageId =
      parsedSendResult?.payload?.messageId ?? parsedSendResult?.payload?.result?.messageId ?? null;
    await waitForDiscordMessage({
      token,
      channelId,
      needle: outboundNonce,
    });
    hostMessageId = await postDiscordMessage({
      token,
      channelId,
      content: inboundNonce,
    });
    await waitForInstalledDiscordReadback({
      cliPath: params.cliPath,
      cwd: params.lane.homeDir,
      env: { ...params.env, DISCORD_BOT_TOKEN: token },
      logPath: params.logPath,
      channelId,
      needle: inboundNonce,
    });
    return "pass";
  } finally {
    await deleteDiscordMessage({ token, channelId, messageId: sentMessageId });
    await deleteDiscordMessage({ token, channelId, messageId: hostMessageId });
  }
}

async function installTarballPackage(params) {
  await installPackageSpec({
    lane: params.lane,
    env: params.env,
    packageSpec: params.tgzPath,
    logPath: params.logPath,
    timeoutMs: params.timeoutMs,
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

async function installPackageSpec(params) {
  const installEnv = {
    ...params.env,
    npm_config_global: "true",
    npm_config_location: "global",
    npm_config_prefix: params.lane.prefixDir,
  };
  rmSync(installedPackageRoot(params.lane.prefixDir), { force: true, recursive: true });
  await runCommand(
    npmCommand(),
    [
      "install",
      "-g",
      params.packageSpec,
      "--omit=dev",
      "--no-fund",
      "--no-audit",
      "--loglevel=notice",
    ],
    {
      cwd: params.lane.homeDir,
      env: installEnv,
      logPath: params.logPath,
      timeoutMs: params.timeoutMs ?? installTimeoutMs(),
    },
  );
}

function installTimeoutMs() {
  return process.platform === "win32" ? 45 * 60 * 1000 : 20 * 60 * 1000;
}

function updateTimeoutMs() {
  return process.platform === "win32" ? 30 * 60 * 1000 : 20 * 60 * 1000;
}

function updateStepTimeoutSeconds() {
  return process.platform === "win32" ? 1800 : 1200;
}

async function runBundledPluginPostinstall(params) {
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

async function runInstalledBrowserOverrideImportSmoke(params) {
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

function ensureLocalNpmShim(lane) {
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

async function runOnboard(params) {
  await withAllocatedGatewayPort(params.lane, async () => {
    await runOpenClaw({
      lane: params.lane,
      env: params.env,
      args: buildReleaseOnboardArgs({
        authChoice: params.providerConfig.authChoice,
        gatewayPort: params.lane.gatewayPort,
        skipHealth: true,
      }),
      logPath: params.logPath,
      timeoutMs: 10 * 60 * 1000,
    });
  });
}

async function exerciseManagedGatewayLifecycle(params) {
  logLanePhase(params.lane, "gateway-ready");
  await ensureManagedGatewayReady({
    lane: params.lane,
    cliPath: params.cliPath,
    env: params.env,
    logPath: `${params.logPrefix}-ready.log`,
  });

  logLanePhase(params.lane, "gateway-restart");
  await runInstalledCli({
    cliPath: params.cliPath,
    args: ["gateway", "restart"],
    env: params.env,
    cwd: params.lane.homeDir,
    logPath: `${params.logPrefix}-restart.log`,
    timeoutMs: 2 * 60 * 1000,
  });
  await ensureManagedGatewayReady({
    lane: params.lane,
    cliPath: params.cliPath,
    env: params.env,
    logPath: `${params.logPrefix}-ready-after-restart.log`,
  });

  logLanePhase(params.lane, "gateway-stop");
  await runInstalledCli({
    cliPath: params.cliPath,
    args: ["gateway", "stop"],
    env: params.env,
    cwd: params.lane.homeDir,
    logPath: `${params.logPrefix}-stop.log`,
    timeoutMs: 2 * 60 * 1000,
  });

  logLanePhase(params.lane, "gateway-start");
  await runInstalledCli({
    cliPath: params.cliPath,
    args: ["gateway", "start"],
    env: params.env,
    cwd: params.lane.homeDir,
    logPath: `${params.logPrefix}-start.log`,
    timeoutMs: 2 * 60 * 1000,
  });
  await ensureManagedGatewayReady({
    lane: params.lane,
    cliPath: params.cliPath,
    env: params.env,
    logPath: `${params.logPrefix}-ready-after-start.log`,
  });
}

async function startGateway(params) {
  const gatewayLog = createWriteStream(params.logPath, { flags: "a" });
  const child = spawn(
    process.execPath,
    [
      installedEntryPath(params.lane.prefixDir),
      "gateway",
      "run",
      "--bind",
      "loopback",
      "--port",
      String(params.lane.gatewayPort),
      "--force",
    ],
    {
      cwd: params.lane.homeDir,
      env: params.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  child.stdout?.on("data", (chunk) => {
    gatewayLog.write(chunk);
  });
  child.stderr?.on("data", (chunk) => {
    gatewayLog.write(chunk);
  });
  let logClosed = false;
  const closeLog = async () => {
    if (logClosed) {
      return;
    }
    logClosed = true;
    await new Promise((resolvePromise) => {
      gatewayLog.once("error", () => resolvePromise());
      gatewayLog.end(() => resolvePromise());
    });
  };
  child.once("close", () => {
    void closeLog();
  });
  child.once("error", () => {
    void closeLog();
  });
  return { child, closeLog, logPath: params.logPath };
}

async function waitForGateway(params) {
  const statusArgs = await resolveGatewayStatusArgs(params.lane, params.env, params.logPath);
  const deadline = Date.now() + gatewayReadyDeadlineMs();
  while (Date.now() < deadline) {
    let result;
    try {
      result = await runOpenClaw({
        lane: params.lane,
        env: params.env,
        args: statusArgs,
        logPath: params.logPath,
        timeoutMs: CROSS_OS_GATEWAY_STATUS_COMMAND_TIMEOUT_MS,
        check: false,
      });
    } catch {
      await sleep(2_000);
      continue;
    }
    if (result.exitCode === 0) {
      return;
    }
    await sleep(2_000);
  }
  throw new Error(`Gateway did not become ready on port ${params.lane.gatewayPort}.`);
}

function gatewayReadyDeadlineMs() {
  return process.platform === "win32"
    ? CROSS_OS_WINDOWS_GATEWAY_READY_TIMEOUT_MS
    : CROSS_OS_GATEWAY_READY_TIMEOUT_MS;
}

async function resolveGatewayStatusArgs(lane, env, logPath) {
  const help = await runOpenClaw({
    lane,
    env,
    args: ["gateway", "status", "--help"],
    logPath,
    timeoutMs: 15_000,
    check: false,
  });
  if (help.stdout.includes("--require-rpc") || help.stderr.includes("--require-rpc")) {
    return [
      "gateway",
      "status",
      "--require-rpc",
      "--timeout",
      String(CROSS_OS_GATEWAY_STATUS_RPC_TIMEOUT_MS),
    ];
  }
  return ["gateway", "status"];
}

async function runModelsSet(params) {
  await runOpenClaw({
    lane: params.lane,
    env: params.env,
    args: ["models", "set", params.providerConfig.model],
    logPath: params.logPath,
    timeoutMs: 2 * 60 * 1000,
  });
  const providerConfigOverride = buildReleaseProviderConfigOverride(params.providerConfig);
  if (providerConfigOverride) {
    await runOpenClaw({
      lane: params.lane,
      env: params.env,
      args: [
        "config",
        "set",
        `models.providers.${params.providerConfig.extensionId}`,
        JSON.stringify(providerConfigOverride),
        "--strict-json",
        "--merge",
      ],
      logPath: params.logPath,
      timeoutMs: 2 * 60 * 1000,
    });
  }
  await runOpenClaw({
    lane: params.lane,
    env: params.env,
    args: [
      "config",
      "set",
      "plugins.allow",
      JSON.stringify(buildCrossOsReleaseSmokePluginAllowlist(params.providerConfig)),
      "--strict-json",
    ],
    logPath: params.logPath,
    timeoutMs: 2 * 60 * 1000,
  });
  await runOpenClaw({
    lane: params.lane,
    env: params.env,
    args: ["config", "set", "agents.defaults.skipBootstrap", "true", "--strict-json"],
    logPath: params.logPath,
    timeoutMs: 2 * 60 * 1000,
  });
  await runOpenClaw({
    lane: params.lane,
    env: params.env,
    args: ["config", "set", "tools.profile", CROSS_OS_RELEASE_SMOKE_TOOLS_PROFILE],
    logPath: params.logPath,
    timeoutMs: 2 * 60 * 1000,
  });
}

async function runAgentTurn(params) {
  let lastError;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const sessionId = `cross-os-release-check-${params.label}-${Date.now()}-${attempt}`;
    try {
      const result = await runOpenClaw({
        lane: params.lane,
        env: params.env,
        args: buildReleaseAgentTurnArgs(sessionId),
        logPath: params.logPath,
        timeoutMs: (CROSS_OS_AGENT_TURN_TIMEOUT_SECONDS + 60) * 1000,
      });
      if (!agentOutputHasExpectedOkMarker(result.stdout, { logPath: params.logPath })) {
        throw new Error("Agent output did not contain the expected OK marker.");
      }
      return result;
    } catch (error) {
      lastError = error;
      const skipped = maybeBuildOptionalAgentTurnSkipResult(error, params.logPath);
      if (skipped) {
        return skipped;
      }
      if (attempt >= 2 || !shouldRetryCrossOsAgentTurnError(error)) {
        throw error;
      }
      appendFileSync(
        params.logPath,
        `\n[release-checks] retrying agent turn after retryable live failure: ${
          error instanceof Error ? error.message : String(error)
        }\n`,
      );
    }
  }
  throw lastError;
}

function maybeBuildOptionalAgentTurnSkipResult(error, logPath) {
  if (!CROSS_OS_AGENT_TURN_OPTIONAL || !shouldSkipOptionalCrossOsAgentTurnError(error, logPath)) {
    return null;
  }
  const message = error instanceof Error ? error.message : String(error);
  appendFileSync(
    logPath,
    `\n[release-checks] skipping optional cross-OS live agent turn after retryable failure: ${message}\n`,
  );
  return {
    status: 0,
    stdout: JSON.stringify({
      status: "skipped",
      reason: "cross-os live agent turn unavailable after retry",
    }),
    stderr: "",
  };
}

export function shouldSkipOptionalCrossOsAgentTurnError(error, logPath) {
  const message = error instanceof Error ? error.message : String(error);
  if (
    /model idle timeout|did not produce a response before the model idle timeout|gateway request timeout for agent|Command timed out|timed out and could not be terminated cleanly/u.test(
      message,
    )
  ) {
    return true;
  }
  if (!/Agent output did not contain the expected OK marker/u.test(message)) {
    return false;
  }
  try {
    const log = readFileSync(logPath, "utf8");
    return /"status"\s*:\s*"timeout"|Request timed out before a response was generated/u.test(log);
  } catch {
    return false;
  }
}

function buildReleaseAgentTurnArgs(sessionId) {
  return [
    "agent",
    "--agent",
    "main",
    "--session-id",
    sessionId,
    "--message",
    "Reply with exact ASCII text OK only.",
    "--thinking",
    "minimal",
    "--timeout",
    String(CROSS_OS_AGENT_TURN_TIMEOUT_SECONDS),
    "--json",
  ];
}

export function shouldRetryCrossOsAgentTurnError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /Agent output did not contain the expected OK marker|model idle timeout|did not produce a response before the model idle timeout|gateway request timeout for agent|Command timed out|timed out and could not be terminated cleanly/u.test(
    message,
  );
}

export function agentOutputHasExpectedOkMarker(stdout, options = {}) {
  const payloadTexts = parseAgentPayloadTexts(stdout);
  if (payloadTexts.some((text) => text.trim() === "OK")) {
    return true;
  }
  if (typeof options.logPath !== "string") {
    return false;
  }
  try {
    const logTexts = parseAgentPayloadTexts(readFileSync(options.logPath, "utf8"));
    return logTexts.some((text) => text.trim() === "OK");
  } catch {
    return false;
  }
}

function parseAgentPayloadTexts(stdout) {
  try {
    const payload = JSON.parse(stdout);
    const directTexts = [
      payload?.finalAssistantVisibleText,
      payload?.finalAssistantRawText,
      payload?.meta?.finalAssistantVisibleText,
      payload?.meta?.finalAssistantRawText,
      payload?.result?.finalAssistantVisibleText,
      payload?.result?.finalAssistantRawText,
      payload?.result?.meta?.finalAssistantVisibleText,
      payload?.result?.meta?.finalAssistantRawText,
    ].filter((text): text is string => typeof text === "string");
    const entries = Array.isArray(payload?.payloads)
      ? payload.payloads
      : Array.isArray(payload?.result?.payloads)
        ? payload.result.payloads
        : [];
    const payloadTexts = Array.isArray(entries)
      ? entries.flatMap((entry) => (typeof entry?.text === "string" ? [entry.text] : []))
      : [];
    return [...directTexts, ...payloadTexts];
  } catch {
    const finalTextMatches = [
      ...stdout.matchAll(
        /"(?:finalAssistantVisibleText|finalAssistantRawText|text)"\s*:\s*"([^"]*)"/gu,
      ),
    ].map((match) => match[1]);
    return finalTextMatches.length > 0 ? finalTextMatches : stdout.trim() ? [stdout] : [];
  }
}

async function runDashboardSmoke(params) {
  const dashboardUrl = `http://127.0.0.1:${params.lane.gatewayPort}/`;
  const logStream = createWriteStream(params.logPath, { flags: "a" });
  const deadline = Date.now() + CROSS_OS_DASHBOARD_SMOKE_TIMEOUT_MS;
  let attempt = 0;
  try {
    while (Date.now() < deadline) {
      attempt += 1;
      logStream.write(`${new Date().toISOString()} attempt=${attempt} url=${dashboardUrl}\n`);
      try {
        const response = await fetch(dashboardUrl, {
          signal: AbortSignal.timeout(CROSS_OS_DASHBOARD_FETCH_TIMEOUT_MS),
        });
        const html = await response.text();
        if (
          response.ok &&
          html.includes("<title>OpenClaw Control</title>") &&
          html.includes("<openclaw-app></openclaw-app>")
        ) {
          logStream.write(
            `${new Date().toISOString()} dashboard-ready status=${response.status}\n`,
          );
          return;
        }
        logStream.write(
          `${new Date().toISOString()} dashboard-not-ready status=${response.status} title=${html.includes("<title>OpenClaw Control</title>")} app=${html.includes("<openclaw-app></openclaw-app>")}\n`,
        );
      } catch (error) {
        logStream.write(
          `${new Date().toISOString()} dashboard-fetch-error ${formatError(error)}\n`,
        );
      }
      await sleep(1_000);
    }
  } finally {
    logStream.end();
  }
  throw new Error(`Dashboard HTML did not become ready at ${dashboardUrl}.`);
}

async function stopGateway(gateway) {
  try {
    if (!gateway?.child?.pid) {
      return;
    }
    if (process.platform === "win32") {
      await runCommand("taskkill", ["/PID", String(gateway.child.pid), "/T", "/F"], {
        logPath: gateway.logPath,
        check: false,
        timeoutMs: 30_000,
      });
      const exited = await waitForChildExit(gateway.child, 10_000);
      if (!exited) {
        gateway.child.stdout?.destroy();
        gateway.child.stderr?.destroy();
      }
      return;
    }
    if (gateway.child.exitCode !== null) {
      return;
    }
    gateway.child.kill("SIGTERM");
    const exitedAfterTerm = await waitForChildExit(gateway.child, 2_000);
    if (!exitedAfterTerm && gateway.child.exitCode === null) {
      gateway.child.kill("SIGKILL");
      await waitForChildExit(gateway.child, 5_000);
    }
  } finally {
    await gateway?.closeLog?.();
  }
}

async function waitForChildExit(child, timeoutMs) {
  if (child.exitCode !== null) {
    return true;
  }
  return new Promise((resolvePromise) => {
    let settled = false;
    const finish = (didExit) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      child.off("exit", onExit);
      child.off("close", onClose);
      child.off("error", onError);
      resolvePromise(didExit);
    };
    const onExit = () => finish(true);
    const onClose = () => finish(true);
    const onError = () => finish(true);
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            finish(false);
          }, timeoutMs)
        : null;

    child.once("exit", onExit);
    child.once("close", onClose);
    child.once("error", onError);
  });
}

async function runCleanup(cleanupFns) {
  for (const cleanupFn of cleanupFns.toReversed()) {
    try {
      await cleanupFn();
    } catch {
      // Ignore cleanup failures so the main failure surface stays visible.
    }
  }
}

async function runOpenClaw(params) {
  return runCommand(process.execPath, [installedEntryPath(params.lane.prefixDir), ...params.args], {
    cwd: params.lane.homeDir,
    env: params.env,
    logPath: params.logPath,
    timeoutMs: params.timeoutMs,
    check: params.check ?? true,
  });
}

function readInstalledPackageManifest(prefixDir) {
  const packageRoot = installedPackageRoot(prefixDir);
  return readInstalledPackageManifestFromPackageRoot(packageRoot);
}

function readInstalledPackageManifestFromPackageRoot(packageRoot) {
  const packageJsonPath = join(packageRoot, "package.json");
  if (!existsSync(packageJsonPath)) {
    throw new Error(`Installed package manifest missing: ${packageJsonPath}`);
  }
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
    version?: unknown;
  };
  return { packageJson, packageRoot };
}

export function readInstalledVersion(prefixDir) {
  const { packageJson } = readInstalledPackageManifest(prefixDir);
  return typeof packageJson.version === "string" ? packageJson.version.trim() : "";
}

function readInstalledMetadata(prefixDir) {
  const { packageJson, packageRoot } = readInstalledPackageManifest(prefixDir);
  return readInstalledMetadataFromManifest(packageJson, packageRoot);
}

function readInstalledMetadataFromPackageRoot(packageRoot) {
  const { packageJson } = readInstalledPackageManifestFromPackageRoot(packageRoot);
  return readInstalledMetadataFromManifest(packageJson, packageRoot);
}

function readInstalledMetadataFromManifest(packageJson, packageRoot) {
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

function verifyInstalledCandidate(installed, build) {
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
  cliPath,
  platform = process.platform,
  env = process.env,
) {
  const prefixDir = resolveInstalledPrefixDirFromCliPath(cliPath, platform);
  const candidates = [installedPackageRoot(prefixDir, platform)];

  if (platform !== "win32") {
    const resolvedCliPath = String(cliPath ?? "").trim();
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

function installedPackageRoot(prefixDir, platform = process.platform) {
  return platform === "win32"
    ? join(prefixDir, "node_modules", "openclaw")
    : join(prefixDir, "lib", "node_modules", "openclaw");
}

function installedEntryPath(prefixDir) {
  return join(installedPackageRoot(prefixDir), "openclaw.mjs");
}

function npmShimPath(prefixDir) {
  return process.platform === "win32" ? join(prefixDir, "npm.cmd") : join(prefixDir, "bin", "npm");
}

function binDirForPrefix(prefixDir) {
  return process.platform === "win32" ? prefixDir : join(prefixDir, "bin");
}

function pnpmCommand() {
  return process.platform === "win32" ? "pnpm.cmd" : "pnpm";
}

function npmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function gitCommand() {
  return process.platform === "win32" ? "git.exe" : "git";
}

async function runCommand(command, args, options) {
  return new Promise((resolvePromise, rejectPromise) => {
    const useWindowsShell = process.platform === "win32" && /\.(cmd|bat)$/iu.test(command);
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      shell: useWindowsShell,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const logStream = createWriteStream(options.logPath, { flags: "a" });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const clearTimers = () => {
      if (timer) {
        clearTimeout(timer);
      }
      if (killWaitTimer) {
        clearTimeout(killWaitTimer);
      }
    };

    const finalize = (callback) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimers();
      logStream.end();
      callback();
    };

    const requestKill = () => {
      if (process.platform === "win32" && child.pid) {
        try {
          const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
            stdio: "ignore",
            windowsHide: true,
          });
          killer.on("error", () => {
            child.kill();
          });
          return;
        } catch {
          child.kill();
          return;
        }
      }
      child.kill(process.platform === "win32" ? undefined : "SIGKILL");
    };

    let killWaitTimer = null;
    const timer =
      options.timeoutMs && Number.isFinite(options.timeoutMs)
        ? setTimeout(() => {
            timedOut = true;
            logStream.write(
              `${new Date().toISOString()} timeout command=${command} args=${args.join(" ")}\n`,
            );
            requestKill();
            killWaitTimer = setTimeout(() => {
              finalize(() => {
                rejectPromise(
                  new Error(
                    `Command timed out and could not be terminated cleanly: ${command} ${args.join(" ")}`,
                  ),
                );
              });
            }, 15_000);
          }, options.timeoutMs)
        : null;

    child.stdout?.on("data", (chunk) => {
      const text = chunk.toString();
      stdout += text;
      logStream.write(text);
    });
    child.stderr?.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      logStream.write(text);
    });

    child.on("error", (error) => {
      finalize(() => rejectPromise(error));
    });

    child.on("close", (exitCode) => {
      finalize(() => {
        const result = {
          exitCode: exitCode ?? 1,
          stdout,
          stderr,
        };
        if (timedOut) {
          rejectPromise(new Error(`Command timed out: ${command} ${args.join(" ")}`));
          return;
        }
        if ((options.check ?? true) && result.exitCode !== 0) {
          rejectPromise(
            new Error(
              `Command failed (${result.exitCode}): ${command} ${args.join(" ")}\n${trimForSummary(
                `${stdout}\n${stderr}`,
              )}`,
            ),
          );
          return;
        }
        resolvePromise(result);
      });
    });
  });
}

async function startStaticFileServer(params) {
  mkdirSync(dirname(params.logPath), { recursive: true });
  const logStream = createWriteStream(params.logPath, { flags: "a" });
  const fileName = String(params.filePath.split(/[/\\]/u).at(-1) ?? "artifact");
  const fileBytes = readFileSync(params.filePath);
  const server = createServer((request, response) => {
    logStream.write(`${new Date().toISOString()} ${request.method} ${request.url}\n`);
    if (request.url !== `/${fileName}`) {
      response.statusCode = 404;
      response.end("not found");
      return;
    }
    response.statusCode = 200;
    response.setHeader("content-type", resolveStaticFileContentType(params.filePath));
    response.setHeader("content-length", String(fileBytes.length));
    response.end(fileBytes);
  });
  await new Promise((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to bind static file server.");
  }
  const port = address.port;
  return {
    url: `http://127.0.0.1:${port}/${fileName}`,
    close: () =>
      new Promise((resolvePromise, rejectPromise) => {
        server.close((error) => {
          logStream.end();
          if (error) {
            rejectPromise(error);
            return;
          }
          resolvePromise();
        });
      }),
  };
}

export function resolveStaticFileContentType(filePath) {
  if (filePath.endsWith(".sh") || filePath.endsWith(".ps1")) {
    return "text/plain; charset=utf-8";
  }
  return "application/octet-stream";
}

export function resolvePublishedInstallerUrl(platform = process.platform) {
  if (platform === "win32") {
    return `${PUBLISHED_INSTALLER_BASE_URL}/install.ps1`;
  }
  return `${PUBLISHED_INSTALLER_BASE_URL}/install.sh`;
}

function writeSummary(baseDir, summaryPayload) {
  const summaryJsonPath = join(baseDir, "summary.json");
  const summaryMarkdownPath = join(baseDir, "summary.md");
  writeFileSync(summaryJsonPath, `${JSON.stringify(summaryPayload, null, 2)}\n`, "utf8");
  const result = summaryPayload.result ?? {};

  const lines = [
    `## ${platformLabel()}`,
    "",
    `- Provider: \`${summaryPayload.provider}\``,
    `- Suite: \`${summaryPayload.suite}\``,
    `- Mode: \`${summaryPayload.mode}\``,
    `- Source SHA: \`${summaryPayload.sourceSha || "unknown"}\``,
    `- Candidate version: \`${summaryPayload.candidateVersion || "unknown"}\``,
    `- Baseline spec: \`${summaryPayload.baselineSpec}\``,
    result.status ? `- Result: \`${result.status}\`` : "",
    result.installTarget ? `- Install target: \`${result.installTarget}\`` : "",
    result.installVersion ? `- Install version: \`${result.installVersion}\`` : "",
    result.baselineVersion ? `- Baseline version: \`${result.baselineVersion}\`` : "",
    result.installedVersion ? `- Installed version: \`${result.installedVersion}\`` : "",
    result.installedCommit ? `- Installed commit: \`${result.installedCommit}\`` : "",
    result.cliPath ? `- CLI path: \`${result.cliPath}\`` : "",
    result.gatewayPort ? `- Gateway port: \`${result.gatewayPort}\`` : "",
    result.dashboardStatus ? `- Dashboard: \`${result.dashboardStatus}\`` : "",
    result.discordStatus ? `- Discord: \`${result.discordStatus}\`` : "",
    result.agentOutput ? `- Agent output: \`${trimForSummary(result.agentOutput)}\`` : "",
    result.error ? `- Error: \`${trimForSummary(result.error)}\`` : "",
  ].filter(Boolean);
  writeFileSync(summaryMarkdownPath, `${lines.join("\n")}\n`, "utf8");
}

function writeCandidateManifest(baseDir, build) {
  const manifestPath = join(baseDir, "candidate.json");
  writeFileSync(
    manifestPath,
    `${JSON.stringify(
      {
        sourceSha: build.sourceSha,
        candidateVersion: build.candidateVersion,
        candidateFileName: build.candidateFileName,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

function platformLabel() {
  if (process.platform === "darwin") {
    return "macOS Release Checks";
  }
  if (process.platform === "win32") {
    return "Windows Release Checks";
  }
  return "Linux Release Checks";
}

function requireArg(argsMap, key) {
  const value = argsMap[key]?.trim();
  if (!value) {
    throw new Error(`Missing required --${key} argument.`);
  }
  return value;
}

function resolveCommandPath(command) {
  const pathValue = process.env.PATH ?? "";
  const pathEntries = pathValue.split(process.platform === "win32" ? ";" : ":").filter(Boolean);
  const candidates =
    process.platform === "win32" && !command.toLowerCase().endsWith(".cmd")
      ? [`${command}.cmd`, `${command}.exe`, command]
      : [command];
  for (const entry of pathEntries) {
    for (const candidate of candidates) {
      const fullPath = join(entry, candidate);
      if (existsSync(fullPath)) {
        return fullPath;
      }
    }
  }
  return null;
}

function shellEscapeForSh(value) {
  return value.replace(/'/gu, `'"'"'`);
}

function logPhase(scope, phase) {
  process.stdout.write(`[release-checks] ${scope}: ${phase}\n`);
}

function logLanePhase(lane, phase) {
  logPhase(`lane.${lane.name}`, phase);
}

function trimForSummary(value) {
  const trimmed = value.trim();
  if (trimmed.length <= 600) {
    return trimmed;
  }
  return `${trimmed.slice(0, 600)}...`;
}

function formatError(error) {
  if (error instanceof Error) {
    return error.stack || error.message;
  }
  return String(error);
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function withAllocatedGatewayPort(lane, callback) {
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const reservation = await reservePort();
    lane.gatewayPort = reservation.port;
    await reservation.release();
    try {
      return await callback();
    } catch (error) {
      lastError = error;
      if (!isAddressInUseError(error) || attempt === 3) {
        throw error;
      }
      await sleep(250 * attempt);
    }
  }
  throw lastError ?? new Error("Failed to allocate a gateway port.");
}

function reservePort() {
  return new Promise((resolvePromise, rejectPromise) => {
    const server = createNetServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        rejectPromise(new Error("Failed to allocate a TCP port."));
        return;
      }
      resolvePromise({
        port: address.port,
        release: () =>
          new Promise((releaseResolve, releaseReject) => {
            server.close((error) => {
              if (error) {
                releaseReject(error);
                return;
              }
              releaseResolve();
            });
          }),
      });
    });
    server.once("error", rejectPromise);
  });
}

function isAddressInUseError(error) {
  const message = formatError(error);
  return message.includes("EADDRINUSE") || /address.+in use/iu.test(message);
}
