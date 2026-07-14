import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  CandidateBuild,
  Cleanup,
  CommandResult,
  GatewayHandle,
  LaneBaseParams,
  LaneState,
  ProviderConfig,
} from "./config.ts";
import {
  buildPackagedUpgradeUpdateArgs,
  buildRealUpdateEnv,
  isRecoverableWindowsPackagedUpgradeSwapCleanupFailure,
  isRecoverableWindowsPackagedUpgradeTimeoutError,
  normalizeRequestedRef,
  resolveDevUpdateVerificationRef,
  resolveExpectedDevUpdateRef,
  shouldExerciseManagedGatewayLifecycleAfterInstall,
  shouldRunMainChannelDevUpdate,
  shouldRunPackagedUpgradeStatusProbe,
  shouldStopManagedGatewayBeforeManualFallback,
  shouldUseManagedGatewayForInstallerRuntime,
  shouldUseManagedGatewayService,
  updateTimeoutMs,
  verifyPackagedUpgradeUpdateResult,
  verifyWindowsPackagedUpgradeFallbackInstall,
} from "./config.ts";
import {
  binDirForPrefix,
  ensureLocalNpmShim,
  installPackageSpec,
  installTarballPackage,
  readInstalledMetadata,
  readInstalledMetadataFromCliPath,
  readInstalledVersion,
  resolveInstalledPrefixDirFromCliPath,
  resolvePublishedInstallerUrl,
  runBundledPluginPostinstall,
  runInstalledBrowserOverrideImportSmoke,
  shouldRunWindowsInstalledBrowserOverrideImportSmoke,
  verifyInstalledCandidate,
} from "./install.ts";
import {
  ensureDevUpdateGitInstall,
  ensureManagedGatewayReady,
  resolveInstallerTargetVersion,
  runInstalledAgentTurn,
  runInstalledCli,
  runInstalledModelsSet,
  runInstallerSmoke,
  runOnboardWithInstalledCli,
  startManualGatewayFromInstalledCli,
  verifyFreshShellCommand,
  verifyWindowsDevUpdateToolchain,
  waitForInstalledGateway,
  waitForInstalledGatewayToStop,
} from "./installed.ts";
import { maybeRunDiscordRoundtrip } from "./network-smokes.ts";
import { runCleanup, startStaticFileServer, stopGateway } from "./process.ts";
import { logLanePhase, runTimedLanePhase } from "./reporting.ts";
import {
  exerciseManagedGatewayLifecycle,
  runAgentTurn,
  runDashboardSmoke,
  runModelsSet,
  runOnboard,
  runOpenClaw,
  startGateway,
  waitForGateway,
} from "./runtime.ts";
import { formatError, trimForSummary } from "./shared.ts";

export async function runFreshLane(params: LaneBaseParams & { build: CandidateBuild }) {
  const lane = createLaneState("fresh");
  const cleanup: Cleanup[] = [];
  try {
    const env = buildLaneEnv(lane, params.providerConfig, params.providerSecretValue);
    await runTimedLanePhase(lane, "install-candidate", async () => {
      await installTarballPackage({
        lane,
        env,
        tgzPath: params.build.candidateTgz,
        logPath: join(params.logsDir, "fresh-install.log"),
        restoreBundledPluginPostinstall: false,
      });
    });
    const installed = readInstalledMetadata(lane.prefixDir);
    verifyInstalledCandidate(installed, params.build);
    await runTimedLanePhase(lane, "run-bundled-plugin-postinstall", async () => {
      await runBundledPluginPostinstall({
        lane,
        env,
        logPath: join(params.logsDir, "fresh-install.log"),
      });
    });

    let browserOverrideImportStatus = "skipped";
    if (shouldRunWindowsInstalledBrowserOverrideImportSmoke()) {
      browserOverrideImportStatus = await runTimedLanePhase(
        lane,
        "windows-browser-override-import",
        async () =>
          runInstalledBrowserOverrideImportSmoke({
            lane,
            env,
            prefixDir: lane.prefixDir,
            logPath: join(params.logsDir, "fresh-windows-browser-override-import.log"),
          }),
      );
    }

    await runTimedLanePhase(lane, "onboard", async () => {
      await runOnboard({
        lane,
        env,
        providerConfig: params.providerConfig,
        logPath: join(params.logsDir, "fresh-onboard.log"),
      });
    });

    await runTimedLanePhase(lane, "models-set", async () => {
      await runModelsSet({
        lane,
        env,
        providerConfig: params.providerConfig,
        logPath: join(params.logsDir, "fresh-models-set.log"),
      });
    });

    const gateway = await runTimedLanePhase(lane, "start-gateway", async () =>
      startGateway({
        lane,
        env,
        logPath: join(params.logsDir, "fresh-gateway.log"),
      }),
    );
    cleanup.push(() => stopGateway(gateway));

    await runTimedLanePhase(lane, "wait-gateway", async () => {
      await waitForGateway({
        lane,
        env,
        logPath: join(params.logsDir, "fresh-gateway-status.log"),
      });
    });

    await runTimedLanePhase(lane, "dashboard", async () => {
      await runDashboardSmoke({
        lane,
        logPath: join(params.logsDir, "fresh-dashboard.log"),
      });
    });

    const agent = await runTimedLanePhase(lane, "agent-turn", async () =>
      runAgentTurn({
        lane,
        env,
        label: "fresh",
        logPath: join(params.logsDir, "fresh-agent.log"),
      }),
    );

    return {
      status: "pass",
      installedVersion: installed.version,
      installedCommit: installed.commit,
      dashboardStatus: "pass",
      gatewayPort: lane.gatewayPort,
      browserOverrideImportStatus,
      agentOutput: trimForSummary(agent.stdout),
      phaseTimings: lane.phaseTimings,
    };
  } finally {
    await runCleanup(cleanup);
  }
}

export async function runUpgradeLane(
  params: LaneBaseParams & {
    baselineSpec: string;
    baselineTgz: string;
    build: CandidateBuild;
    candidateUrl: string;
  },
) {
  if (!params.baselineTgz && !params.baselineSpec) {
    throw new Error("Missing required --baseline-tgz argument for upgrade mode.");
  }
  if (!params.candidateUrl) {
    throw new Error("Missing candidate package URL for upgrade mode.");
  }
  const lane = createLaneState("upgrade");
  const cleanup: Cleanup[] = [];
  try {
    const env = buildLaneEnv(lane, params.providerConfig, params.providerSecretValue);
    await runTimedLanePhase(lane, "install-baseline", async () => {
      if (!params.baselineTgz && params.baselineSpec) {
        await installPackageSpec({
          lane,
          env,
          packageSpec: params.baselineSpec,
          logPath: join(params.logsDir, "upgrade-install-baseline.log"),
          ignoreScripts: true,
        });
      } else {
        await installTarballPackage({
          lane,
          env,
          tgzPath: params.baselineTgz,
          logPath: join(params.logsDir, "upgrade-install-baseline.log"),
          ignoreScripts: true,
          restoreBundledPluginPostinstall: false,
        });
      }
    });
    await runTimedLanePhase(lane, "run-baseline-bundled-plugin-postinstall", async () => {
      await runBundledPluginPostinstall({
        lane,
        env,
        logPath: join(params.logsDir, "upgrade-install-baseline.log"),
      });
    });

    const baseline = {
      version: readInstalledVersion(lane.prefixDir),
    };

    const updateEnv = buildRealUpdateEnv(env);
    const updateArgs = buildPackagedUpgradeUpdateArgs(params.candidateUrl);
    const updateLogPath = join(params.logsDir, "upgrade-update.log");
    let updateResult: CommandResult | undefined;
    let usedWindowsPackagedUpgradeTimeoutFallback = false;
    await runTimedLanePhase(lane, "update", async () => {
      try {
        updateResult = await runOpenClaw({
          lane,
          env: updateEnv,
          args: updateArgs,
          logPath: updateLogPath,
          timeoutMs: updateTimeoutMs(),
          check: false,
        });
      } catch (error) {
        if (!isRecoverableWindowsPackagedUpgradeTimeoutError(error, process.platform)) {
          throw error;
        }
        usedWindowsPackagedUpgradeTimeoutFallback = true;
        appendFileSync(
          updateLogPath,
          `\n[release-checks] Windows baseline updater timed out after fetching candidate; falling back to direct candidate install: ${formatError(error)}\n`,
        );
        updateResult = {
          exitCode: 124,
          stdout: "",
          stderr: formatError(error),
        };
      }
    });
    if (!updateResult) {
      throw new Error("Packaged update completed without a command result.");
    }
    const usedWindowsPackagedUpgradeFallback =
      usedWindowsPackagedUpgradeTimeoutFallback ||
      isRecoverableWindowsPackagedUpgradeSwapCleanupFailure(updateResult, process.platform);
    if (usedWindowsPackagedUpgradeFallback) {
      await runTimedLanePhase(lane, "update-fallback-install", async () => {
        await installPackageSpec({
          lane,
          env,
          packageSpec: params.candidateUrl,
          logPath: join(params.logsDir, "upgrade-update-fallback-install.log"),
          ignoreScripts: true,
        });
        const fallbackInstalledVersion = readInstalledVersion(lane.prefixDir);
        verifyWindowsPackagedUpgradeFallbackInstall({
          installedVersion: fallbackInstalledVersion,
          candidateVersion: params.build.candidateVersion,
        });
        appendFileSync(
          updateLogPath,
          `\n[release-checks] Windows fallback install verified candidate version ${fallbackInstalledVersion}\n`,
        );
      });
    } else {
      verifyPackagedUpgradeUpdateResult(updateResult, {
        candidateVersion: params.build.candidateVersion,
      });
    }

    if (
      shouldRunPackagedUpgradeStatusProbe({
        platform: process.platform,
        usedWindowsPackagedUpgradeFallback,
      })
    ) {
      await runTimedLanePhase(lane, "update-status", async () => {
        await runOpenClaw({
          lane,
          env: updateEnv,
          args: ["update", "status", "--json"],
          logPath: join(params.logsDir, "upgrade-update-status.log"),
          timeoutMs: 2 * 60 * 1000,
        });
      });
    }
    await runTimedLanePhase(lane, "run-bundled-plugin-postinstall", async () => {
      await runBundledPluginPostinstall({
        lane,
        env,
        logPath: join(params.logsDir, "upgrade-bundled-plugin-postinstall.log"),
      });
    });

    const installed = readInstalledMetadata(lane.prefixDir);
    verifyInstalledCandidate(installed, params.build);

    await runTimedLanePhase(lane, "onboard", async () => {
      await runOnboard({
        lane,
        env,
        providerConfig: params.providerConfig,
        logPath: join(params.logsDir, "upgrade-onboard.log"),
      });
    });

    await runTimedLanePhase(lane, "models-set", async () => {
      await runModelsSet({
        lane,
        env,
        providerConfig: params.providerConfig,
        logPath: join(params.logsDir, "upgrade-models-set.log"),
      });
    });

    const gateway = await runTimedLanePhase(lane, "start-gateway", async () =>
      startGateway({
        lane,
        env,
        logPath: join(params.logsDir, "upgrade-gateway.log"),
      }),
    );
    cleanup.push(() => stopGateway(gateway));

    await runTimedLanePhase(lane, "wait-gateway", async () => {
      await waitForGateway({
        lane,
        env,
        logPath: join(params.logsDir, "upgrade-gateway-status.log"),
      });
    });

    await runTimedLanePhase(lane, "dashboard", async () => {
      await runDashboardSmoke({
        lane,
        logPath: join(params.logsDir, "upgrade-dashboard.log"),
      });
    });

    const agent = await runTimedLanePhase(lane, "agent-turn", async () =>
      runAgentTurn({
        lane,
        env,
        label: "upgrade",
        logPath: join(params.logsDir, "upgrade-agent.log"),
      }),
    );

    return {
      status: "pass",
      baselineVersion: baseline.version,
      installedVersion: installed.version,
      installedCommit: installed.commit,
      dashboardStatus: "pass",
      gatewayPort: lane.gatewayPort,
      agentOutput: trimForSummary(agent.stdout),
      phaseTimings: lane.phaseTimings,
    };
  } finally {
    await runCleanup(cleanup);
  }
}

export async function runInstallerFreshSuite(
  params: LaneBaseParams & { build: CandidateBuild; runDiscordRoundtrip: boolean },
) {
  const lane = createLaneState("installer-fresh");
  const cleanup: Cleanup[] = [];
  const usesManagedGateway = shouldUseManagedGatewayService();
  const useManagedGatewayAfterInstall = shouldUseManagedGatewayForInstallerRuntime();
  const manualGateway: { current: GatewayHandle | null } = { current: null };
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

export async function runDevUpdateSuite(
  params: LaneBaseParams & {
    baselineSpec: string;
    ref: string;
    sourceSha: string;
    runDiscordRoundtrip: boolean;
  },
) {
  const lane = createLaneState("dev-update");
  const cleanup: Cleanup[] = [];
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
  const manualGateway: { current: GatewayHandle | null } = { current: null };
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

function createLaneState(name: string): LaneState {
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
    phaseTimings: [],
  };
}

function buildLaneEnv(
  lane: LaneState,
  providerMeta: ProviderConfig,
  providerSecretValue: string,
): NodeJS.ProcessEnv {
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

function buildInstallerEnv(
  lane: LaneState,
  providerMeta: ProviderConfig,
  providerSecretValue: string,
): NodeJS.ProcessEnv {
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
    NODE_OPTIONS: "--max-old-space-size=8192",
    [providerMeta.secretEnv]: providerSecretValue,
  };
}
