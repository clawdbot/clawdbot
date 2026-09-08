import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { theme } from "../../../packages/terminal-core/src/theme.js";
import {
  readGatewayServiceState,
  resolveGatewayService,
  type GatewayService,
} from "../../daemon/service.js";
import { getUpdateRun, recordUpdateRunRepairAttempt } from "../../infra/update-run-ledger.js";
import type { UpdateRunResult } from "../../infra/update-runner.js";
import { defaultRuntime } from "../../runtime.js";
import { formatCliCommand } from "../command-format.js";
import {
  renderRestartDiagnostics,
  waitForGatewayHealthyRestart,
  type GatewayRestartSnapshot,
} from "../daemon-cli/restart-health.js";
import type { UpdateCommandOptions } from "./shared.js";
import {
  recoverInstalledLaunchAgentAfterUpdate,
  type PostUpdateLaunchAgentRecoveryResult,
} from "./update-command-launch-agent-recovery.js";
import {
  isPackageManagerUpdateMode,
  runUpdatedInstallGatewayCommand,
} from "./update-command-service-command.js";
import {
  revalidateManagedGatewayServiceAfterUpdate,
  type PreManagedServiceStop,
} from "./update-command-service-maintenance.js";
import {
  assertGatewayServiceManagementAllowedForUpdate,
  resolveUpdatedGatewayRestartPort,
} from "./update-command-service-plan.js";

type PostUpdateGatewayHealthRecoveryDeps = {
  recoverLaunchAgent?: typeof recoverInstalledLaunchAgentAfterUpdate;
  waitForHealthy?: typeof waitForGatewayHealthyRestart;
};

export async function recoverLaunchAgentAndRecheckGatewayHealth(params: {
  updateRun?: UpdateCommandOptions["run"];
  preserveDefinition?: boolean;
  health: GatewayRestartSnapshot;
  service: GatewayService;
  port: number;
  expectedVersion?: string;
  expectedBuildId?: string;
  env?: NodeJS.ProcessEnv;
  deps?: PostUpdateGatewayHealthRecoveryDeps;
}): Promise<{
  health: GatewayRestartSnapshot;
  launchAgentRecovery: PostUpdateLaunchAgentRecoveryResult | null;
}> {
  if (params.health.healthy || params.preserveDefinition) {
    return { health: params.health, launchAgentRecovery: null };
  }

  const recoverLaunchAgent =
    params.deps?.recoverLaunchAgent ?? recoverInstalledLaunchAgentAfterUpdate;
  const startedAtMs = Date.now();
  const launchAgentRecovery = await recoverLaunchAgent({
    service: params.service,
    env: params.env,
  });
  // Native repair can succeed while readiness still fails; retain both observed outcomes.
  if (launchAgentRecovery.attempted && params.updateRun) {
    const endedAtMs = Date.now();
    const { runId, env } = params.updateRun;
    const repair = getUpdateRun(runId, { env })?.repair ?? [];
    recordUpdateRunRepairAttempt(
      runId,
      {
        attempt: Math.max(0, ...repair.map((entry) => entry.attempt)) + 1,
        status: launchAgentRecovery.recovered ? "succeeded" : "failed",
        startedAtMs,
        endedAtMs,
        summary: launchAgentRecovery.recovered
          ? launchAgentRecovery.message
          : launchAgentRecovery.detail,
      },
      { env },
    );
  }
  if (!launchAgentRecovery.recovered) {
    return { health: params.health, launchAgentRecovery };
  }

  const waitForHealthy = params.deps?.waitForHealthy ?? waitForGatewayHealthyRestart;
  const health = await waitForHealthy({
    service: params.service,
    port: params.port,
    expectedVersion: params.expectedVersion,
    ...(params.expectedBuildId ? { expectedBuildId: params.expectedBuildId } : {}),
    env: params.env,
    supervisorKeepsAlive: true,
    settle: { probes: 12 },
  });
  return { health, launchAgentRecovery };
}

export async function hasLoadedLaunchdKeepAliveSupervisor(params: {
  service: GatewayService;
  env?: NodeJS.ProcessEnv;
}): Promise<boolean> {
  if (process.platform !== "darwin") {
    return false;
  }
  // OpenClaw's loaded LaunchAgent has canonical KeepAlive policy. Read this once before
  // polling so an unloaded agent can still reach the existing recovery path promptly.
  return await params.service.isLoaded({ env: params.env }).catch(() => false);
}

function formatPostUpdateGatewayRecoveryLine(platform: NodeJS.Platform): string {
  const restartCommand = formatCliCommand("openclaw gateway restart");
  const installCommand = formatCliCommand("openclaw gateway install --force");
  const statusCommand = formatCliCommand("openclaw gateway status --deep");
  if (platform === "darwin") {
    return `Recovery: run \`${restartCommand}\`; if the LaunchAgent is installed but not loaded, run \`${installCommand}\` from the logged-in macOS user session, then rerun \`${statusCommand}\`.`;
  }
  if (platform === "linux") {
    return `Recovery: run \`${restartCommand}\`; if the systemd user service is missing, stale, or not active, run \`${installCommand}\` from the same user account, then rerun \`${statusCommand}\`.`;
  }
  if (platform === "win32") {
    return `Recovery: run \`${restartCommand}\`; if the gateway Scheduled Task or Windows login item is missing, stale, or not running, run \`${installCommand}\` from the same user account, then rerun \`${statusCommand}\`.`;
  }
  return `Recovery: run \`${restartCommand}\`; if the local service manager reports the gateway service is missing, stale, or not running, run \`${installCommand}\` from the same user account, then rerun \`${statusCommand}\`.`;
}

export function formatPostUpdateGatewayRecoveryInstructions(
  result: UpdateRunResult,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const lines = [formatPostUpdateGatewayRecoveryLine(platform)];
  const beforeVersion = normalizeOptionalString(result.before?.version);
  if (isPackageManagerUpdateMode(result.mode) && beforeVersion) {
    lines.push(
      `Rollback: reinstall OpenClaw ${beforeVersion} with the same package manager, then rerun \`${formatCliCommand("openclaw gateway install --force")}\`.`,
    );
  }
  return lines;
}

export async function maybeRestartServiceAfterFailedMutableUpdate(params: {
  preManagedServiceStop: PreManagedServiceStop | undefined;
  recovery?: UpdateRunResult["recovery"];
  jsonMode: boolean;
  nodeRunner?: string;
  timeoutMs?: number;
  invocationCwd?: string;
}): Promise<"healthy" | "failed" | undefined> {
  const before = params.preManagedServiceStop;
  if (!before?.stopped || !before.serviceEnv) {
    return undefined;
  }
  if (params.recovery?.serviceRestartSafe !== true || !params.recovery.version) {
    defaultRuntime.error(
      "Managed gateway remains stopped: update safety is unverified. Run `openclaw doctor` and inspect the update failure before restarting.",
    );
    return "failed";
  }
  try {
    const verdict = before.serviceUpdateVerdict;
    if (!verdict || !("root" in verdict)) {
      throw new Error(
        "Stopped service ownership is unknown; restart it manually after inspection.",
      );
    }
    const service = resolveGatewayService();
    let expectedService: Pick<PreManagedServiceStop, "serviceEnv" | "serviceUpdateVerdict"> =
      before;
    const readCurrentService = async () => {
      const state = await readGatewayServiceState(service, {
        env: before.serviceEnv,
        requireEffective: true,
        validateEnvBeforeStatusRead: assertGatewayServiceManagementAllowedForUpdate,
        timeoutMs: params.timeoutMs,
      });
      const inspection = await revalidateManagedGatewayServiceAfterUpdate({
        state,
        root: verdict.root,
        preManagedServiceStop: expectedService,
      });
      // Recovery preserves the current definition. Once observed, even a same-unit
      // replacement during config or health awaits must not inherit this activation.
      expectedService = {
        serviceEnv: state.env,
        serviceUpdateVerdict:
          inspection.kind === "owned" ? { ...inspection, refreshDefinition: false } : inspection,
      };
      return state;
    };
    const state = await readCurrentService();
    const port = await resolveUpdatedGatewayRestartPort({
      serviceEnv: state.env,
      serviceCommand: state.command,
    });
    // Context resolution awaits config reads. Revalidate before the one activation;
    // the installed CLI owns its config dialect and preserves the service definition.
    const current = await readCurrentService();
    await runUpdatedInstallGatewayCommand(
      {
        result: { root: verdict.root },
        opts: { json: params.jsonMode },
        invocationEnv: before.serviceEnv,
        serviceEnv: current.env,
        nodeRunner: params.nodeRunner,
        timeoutMs: params.timeoutMs,
        invocationCwd: params.invocationCwd,
      },
      "restart",
      true,
    );
    const health = await waitForGatewayHealthyRestart({
      service,
      port,
      env: current.env,
      expectedVersion: params.recovery.version,
      expectedBuildId: params.recovery.buildId,
      requireRunningService: true,
      settle: { probes: 12 },
    });
    if (!health.healthy || health.runtime.status !== "running") {
      throw new Error(renderRestartDiagnostics(health).join("\n"));
    }
    await readCurrentService();
    if (!params.jsonMode) {
      defaultRuntime.log(
        theme.muted(
          "Recovered managed gateway service and verified readiness after failed update.",
        ),
      );
    }
    return "healthy";
  } catch (err) {
    defaultRuntime.error(
      `Failed to restart managed gateway service after failed update: ${String(err)}. Run \`openclaw gateway status --deep\` before restarting it manually.`,
    );
    return "failed";
  }
}
