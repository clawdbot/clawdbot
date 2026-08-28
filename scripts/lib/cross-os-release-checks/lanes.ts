import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import type {
  CandidateBuild,
  Cleanup,
  CommandResult,
  GatewayHandle,
  LaneBaseParams,
  LaneResult,
  LaneState,
  PackagedUpgradeFallbackEvidence,
  ProviderConfig,
} from "./config.ts";
import {
  buildPackagedUpgradeUpdateArgs,
  buildRealUpdateEnv,
  isRecoverableWindowsPackagedUpgradeSwapCleanupFailure,
  isRecoverableWindowsPackagedUpgradeTimeoutError,
  normalizeRequestedRef,
  parsePackagedUpgradeUpdateTimings,
  resolveDevUpdateVerificationRef,
  resolveExpectedDevUpdateRef,
  shouldRunMainChannelDevUpdate,
  shouldRunPackagedUpgradeStatusProbe,
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
  resolveInstalledGatewayStopArgs,
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
import { installLaneCompanions } from "./lane-companions.ts";
import { maybeRunDiscordRoundtrip } from "./network-smokes.ts";
import {
  reserveGatewayPortForLane,
  runCleanup,
  startStaticFileServer,
  stopGateway,
} from "./process.ts";
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
  const gatewayHolder: { current: GatewayHandle | null } = { current: null };
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

    await installLaneCompanions({ ...params, lane, env });

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
    gatewayHolder.current = gateway;
    cleanup.push(() => stopGateway(gatewayHolder.current));

    await runTimedLanePhase(lane, "wait-gateway", async () => {
      await waitForGateway({
        lane,
        env,
        gatewayHolder,
        gatewayLogPath: join(params.logsDir, "fresh-gateway.log"),
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
  const gatewayHolder: { current: GatewayHandle | null } = { current: null };
  const result: LaneResult = {
    status: "pending",
    phaseTimings: lane.phaseTimings,
    updateTimings: [],
  };
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
    result.updateTimings = parsePackagedUpgradeUpdateTimings(updateResult.stdout);
    const updateFallback: PackagedUpgradeFallbackEvidence | undefined =
      usedWindowsPackagedUpgradeTimeoutFallback
        ? { reason: "timeout", action: "direct-candidate-install" }
        : isRecoverableWindowsPackagedUpgradeSwapCleanupFailure(updateResult, process.platform)
          ? { reason: "swap-cleanup", action: "direct-candidate-install" }
          : undefined;
    if (updateFallback) {
      result.updateFallback = updateFallback;
    }
    const usedWindowsPackagedUpgradeFallback = Boolean(updateFallback);
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

    await installLaneCompanions({ ...params, lane, env });

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
    gatewayHolder.current = gateway;
    cleanup.push(() => stopGateway(gatewayHolder.current));

    await runTimedLanePhase(lane, "wait-gateway", async () => {
      await waitForGateway({
        lane,
        env,
        gatewayHolder,
        gatewayLogPath: join(params.logsDir, "upgrade-gateway.log"),
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
      ...result,
      status: "pass",
      baselineVersion: baseline.version,
      installedVersion: installed.version,
      installedCommit: installed.commit,
      dashboardStatus: "pass",
      gatewayPort: lane.gatewayPort,
      agentOutput: trimForSummary(agent.stdout),
    };
  } catch (error) {
    return {
      ...result,
      status: "fail",
      error: formatError(error),
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
  const manualGateway: { current: GatewayHandle | null } = { current: null };
  const managedHostLease: { current: ManagedGatewayInstallerHostLease | null } = { current: null };
  let managedHostOwned = false;
  let managedHostEnv: NodeJS.ProcessEnv | null = null;
  let managedHostCliPath = "";
  const run = async () => {
    const installerEnv = buildInstallerEnv(lane, params.providerConfig, params.providerSecretValue);
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
      env: installerEnv,
      installerUrl,
      installTarget,
      logPath: join(params.logsDir, "installer-fresh-install.log"),
    });

    logLanePhase(lane, "fresh-shell");
    const freshShell = await verifyFreshShellCommand({
      lane,
      env: installerEnv,
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
        env: installerEnv,
        prefixDir: resolveInstalledPrefixDirFromCliPath(freshShell.cliPath),
        logPath: join(params.logsDir, "installer-fresh-windows-browser-override-import.log"),
      });
    }

    // Host services must use the runner account's real default identity. Keep the
    // public installer isolated, then switch only the managed-service lifecycle.
    const env = resolveManagedGatewayInstallerEnv({
      env: installerEnv,
      enabled: usesManagedGateway,
    });
    if (usesManagedGateway) {
      const accountHome = env.HOME;
      if (!accountHome) {
        throw new Error("Managed installer service checks require the host account home.");
      }
      managedHostLease.current = acquireManagedGatewayInstallerHostLease(accountHome);
      assertManagedGatewayInstallerHostAvailable({
        accountHome,
        serviceInstalled: false,
      });
      const serviceStatus = await runInstalledCli({
        cliPath: freshShell.cliPath,
        args: ["gateway", "status", "--json", "--no-probe"],
        env,
        cwd: lane.homeDir,
        logPath: join(params.logsDir, "installer-fresh-gateway-preflight.log"),
        timeoutMs: 2 * 60 * 1000,
        check: false,
      });
      assertManagedGatewayInstallerHostAvailable({
        accountHome,
        serviceInstalled: parseManagedGatewayServiceInstalled(serviceStatus),
        pathExists: () => false,
      });
      managedHostOwned = true;
      managedHostEnv = env;
      managedHostCliPath = freshShell.cliPath;
    }

    await installLaneCompanions({ ...params, lane, env, cliPath: freshShell.cliPath });

    // Hold the configured port through onboarding and model setup so another runner process
    // cannot claim it before the manual gateway starts. Release immediately before spawn.
    const gatewayPortReservation = usesManagedGateway
      ? null
      : await reserveGatewayPortForLane(lane);
    if (gatewayPortReservation) {
      cleanup.push(() => gatewayPortReservation.release());
    }

    logLanePhase(lane, "onboard");
    await runOnboardWithInstalledCli({
      lane,
      cliPath: freshShell.cliPath,
      env,
      providerConfig: params.providerConfig,
      installDaemon: usesManagedGateway,
      logPath: join(params.logsDir, "installer-fresh-onboard.log"),
      allocateGatewayPort: gatewayPortReservation === null,
    });

    if (usesManagedGateway) {
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

    // Keep the Windows installer lane validating Scheduled Task registration during
    // onboarding and lifecycle commands, but use a manual gateway for the runtime
    // checks after that so the installer validation does not depend on the more
    // failure-prone managed Windows session state for the remainder of the lane.
    if (usesManagedGateway) {
      logLanePhase(lane, "gateway-stop-managed");
      await runInstalledCli({
        cliPath: freshShell.cliPath,
        args: await resolveInstalledGatewayStopArgs({
          cliPath: freshShell.cliPath,
          cwd: lane.homeDir,
          env,
          logPath: join(params.logsDir, "installer-fresh-gateway-stop-managed-help.log"),
        }),
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
    await gatewayPortReservation?.release();
    logLanePhase(lane, "gateway-start");
    const gateway = await startManualGatewayFromInstalledCli({
      lane,
      cliPath: freshShell.cliPath,
      env,
      logPath: join(params.logsDir, "installer-fresh-gateway.log"),
    });
    manualGateway.current = gateway;
    if (!usesManagedGateway) {
      cleanup.push(() => stopGateway(manualGateway.current));
    }
    logLanePhase(lane, "gateway-status");
    await waitForInstalledGateway({
      lane,
      cliPath: freshShell.cliPath,
      env,
      gatewayHolder: manualGateway,
      gatewayLogPath: join(params.logsDir, "installer-fresh-gateway.log"),
      logPath: join(params.logsDir, "installer-fresh-gateway-status.log"),
    });

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
  };

  let result: Awaited<ReturnType<typeof run>> | undefined;
  let runError: Error | undefined;
  try {
    result = await run();
  } catch (error) {
    runError = error instanceof Error ? error : new Error(formatError(error));
  }

  let managedCleanupError: Error | undefined;
  const acquiredManagedHostLease = managedHostLease.current;
  if (acquiredManagedHostLease) {
    let hostCleanupError: Error | undefined;
    try {
      if (managedHostOwned && managedHostEnv && managedHostCliPath) {
        await cleanupManagedGatewayInstallerHost({
          accountHome: acquiredManagedHostLease.accountHome,
          cliPath: managedHostCliPath,
          env: managedHostEnv,
          lane,
          logsDir: params.logsDir,
          manualGateway: manualGateway.current,
        });
      }
    } catch (error) {
      hostCleanupError = error instanceof Error ? error : new Error(formatError(error));
    }
    let leaseReleaseError: Error | undefined;
    try {
      acquiredManagedHostLease.release();
    } catch (error) {
      leaseReleaseError = error instanceof Error ? error : new Error(formatError(error));
    }
    if (hostCleanupError && leaseReleaseError) {
      managedCleanupError = new AggregateError(
        [hostCleanupError, leaseReleaseError],
        "Managed-service cleanup and host-lease release both failed.",
        { cause: leaseReleaseError },
      );
    } else {
      managedCleanupError = hostCleanupError ?? leaseReleaseError;
    }
  }
  await runCleanup(cleanup);
  if (managedCleanupError && runError) {
    throw new AggregateError(
      [runError, managedCleanupError],
      "Installer release check and managed-service cleanup both failed.",
      { cause: managedCleanupError },
    );
  }
  if (managedCleanupError) {
    throw managedCleanupError;
  }
  if (runError) {
    throw runError;
  }
  if (!result) {
    throw new Error("Installer release check completed without a result.");
  }
  return result;
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
  // Keep dev-update on a manual gateway even on Windows. The packaged lanes
  // already cover the Scheduled Task path, while repaired git installs live in
  // an ephemeral checkout that has proven flaky as a managed service in CI.
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

    await installLaneCompanions({ ...params, lane, env, cliPath: verifiedShell.cliPath });

    logLanePhase(lane, "onboard");
    await runOnboardWithInstalledCli({
      lane,
      cliPath: verifiedShell.cliPath,
      env,
      providerConfig: params.providerConfig,
      installDaemon: false,
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
      gatewayHolder: manualGateway,
      gatewayLogPath: join(params.logsDir, "dev-update-gateway.log"),
      logPath: join(params.logsDir, "dev-update-gateway-status.log"),
    });

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

export function resolveManagedGatewayInstallerEnv(params: {
  env: NodeJS.ProcessEnv;
  enabled: boolean;
  accountHome?: string;
  hostEnv?: NodeJS.ProcessEnv;
}): NodeJS.ProcessEnv {
  if (!params.enabled) {
    return params.env;
  }
  const accountHome = params.accountHome ?? userInfo().homedir;
  const hostEnv = params.hostEnv ?? process.env;
  const env: NodeJS.ProcessEnv = {
    ...params.env,
    HOME: accountHome,
    USERPROFILE: accountHome,
    APPDATA: hostEnv.APPDATA,
    LOCALAPPDATA: hostEnv.LOCALAPPDATA,
  };
  const isolatedIdentityKeys = new Set(
    [
      "OPENCLAW_HOME",
      "OPENCLAW_PROFILE",
      "OPENCLAW_STATE_DIR",
      "OPENCLAW_CONFIG_PATH",
      "OPENCLAW_WINDOWS_TASK_NAME",
      "OPENCLAW_TASK_SCRIPT_NAME",
      "OPENCLAW_TASK_SCRIPT",
      "OPENCLAW_SERVICE_KIND",
    ].map((key) => key.toUpperCase()),
  );
  // Windows environment keys are case-insensitive. Remove every casing variant
  // so the installed CLI cannot inherit the isolated lane identity.
  for (const key of Object.keys(env)) {
    if (isolatedIdentityKeys.has(key.toUpperCase())) {
      delete env[key];
    }
  }
  return env;
}

export function parseManagedGatewayServiceInstalled(result: CommandResult): boolean {
  if (result.exitCode !== 0) {
    throw new Error(`Managed gateway preflight failed with exit code ${result.exitCode}.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new Error("Managed gateway preflight did not return JSON status.");
  }
  // The managed installer lane is Windows-only. Its status `loaded` field is backed by
  // isScheduledTaskInstalled, which covers both the registered task and Startup fallback.
  const installed =
    parsed && typeof parsed === "object" && "service" in parsed
      ? (parsed.service as { loaded?: unknown }).loaded
      : undefined;
  if (typeof installed !== "boolean") {
    throw new Error("Managed gateway preflight omitted service.loaded.");
  }
  return installed;
}

export function assertManagedGatewayInstallerHostAvailable(params: {
  accountHome: string;
  serviceInstalled: boolean;
  pathExists?: (path: string) => boolean;
}): void {
  const pathExists = params.pathExists ?? existsSync;
  const occupiedStateDirs = [".openclaw", ".clawdbot"]
    .map((name) => join(params.accountHome, name))
    .filter((path) => pathExists(path));
  if (params.serviceInstalled || occupiedStateDirs.length > 0) {
    throw new Error(
      "Managed installer service checks require a pristine host account with no OpenClaw service or state.",
    );
  }
}

type ManagedGatewayInstallerHostLease = {
  accountHome: string;
  release: () => void;
};

export function acquireManagedGatewayInstallerHostLease(
  accountHome: string,
): ManagedGatewayInstallerHostLease {
  const lockDir = join(accountHome, ".openclaw-release-check.lock");
  try {
    mkdirSync(lockDir);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") {
      throw new Error(
        "Managed installer service checks require exclusive access to the host account; another check or stale lease is present.",
        { cause: error },
      );
    }
    throw error;
  }
  try {
    writeFileSync(
      join(lockDir, "owner.json"),
      `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`,
      "utf8",
    );
  } catch (error) {
    rmSync(lockDir, { recursive: true, force: true });
    throw error;
  }
  let released = false;
  return {
    accountHome,
    release: () => {
      if (released) {
        return;
      }
      rmSync(lockDir, { recursive: true });
      released = true;
    },
  };
}

async function cleanupManagedGatewayInstallerHost(params: {
  accountHome: string;
  cliPath: string;
  env: NodeJS.ProcessEnv;
  lane: LaneState;
  logsDir: string;
  manualGateway: GatewayHandle | null;
}): Promise<void> {
  const cleanupErrors: Error[] = [];
  try {
    await stopGateway(params.manualGateway);
  } catch (error) {
    cleanupErrors.push(error instanceof Error ? error : new Error(formatError(error)));
  }

  let serviceRemoved = false;
  try {
    const uninstallResult = await runInstalledCli({
      cliPath: params.cliPath,
      args: ["gateway", "uninstall"],
      env: params.env,
      cwd: params.lane.homeDir,
      logPath: join(params.logsDir, "installer-fresh-gateway-uninstall.log"),
      timeoutMs: 2 * 60 * 1000,
      check: false,
    });
    if (uninstallResult.exitCode === 0) {
      serviceRemoved = true;
    } else {
      const statusResult = await runInstalledCli({
        cliPath: params.cliPath,
        args: ["gateway", "status", "--json", "--no-probe"],
        env: params.env,
        cwd: params.lane.homeDir,
        logPath: join(params.logsDir, "installer-fresh-gateway-cleanup-status.log"),
        timeoutMs: 2 * 60 * 1000,
        check: false,
      });
      if (parseManagedGatewayServiceInstalled(statusResult)) {
        throw new Error(
          `Managed gateway uninstall failed with exit code ${uninstallResult.exitCode}; the service remains installed.`,
        );
      }
      serviceRemoved = true;
    }
  } catch (error) {
    cleanupErrors.push(error instanceof Error ? error : new Error(formatError(error)));
  }

  if (serviceRemoved) {
    try {
      rmSync(join(params.accountHome, ".openclaw"), { recursive: true, force: true });
      rmSync(join(params.accountHome, ".clawdbot"), { recursive: true, force: true });
    } catch (error) {
      cleanupErrors.push(error instanceof Error ? error : new Error(formatError(error)));
    }
  }

  const firstCleanupError = cleanupErrors[0];
  if (cleanupErrors.length === 1 && firstCleanupError) {
    throw firstCleanupError;
  }
  if (cleanupErrors.length > 1) {
    throw new AggregateError(cleanupErrors, "Managed-service cleanup failed.", {
      cause: cleanupErrors.at(-1),
    });
  }
}
