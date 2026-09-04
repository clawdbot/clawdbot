import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { GatewayService } from "../../daemon/service.js";
import type { UpdateRunResult } from "../../infra/update-runner.js";
import { replaceCliName, resolveCliName } from "../cli-name.js";
import { formatCliCommand } from "../command-format.js";
import {
  waitForGatewayHealthyRestart,
  type GatewayRestartSnapshot,
} from "../daemon-cli/restart-health.js";
import {
  recoverInstalledLaunchAgentAfterUpdate,
  type PostUpdateLaunchAgentRecoveryResult,
} from "./update-command-launch-agent-recovery.js";

const CLI_NAME = resolveCliName();

export function isPackageManagerUpdateMode(
  mode: UpdateRunResult["mode"],
): mode is "npm" | "pnpm" | "bun" {
  return mode === "npm" || mode === "pnpm" || mode === "bun";
}

export function shouldUseLegacyProcessRestartAfterUpdate(params: {
  updateMode: UpdateRunResult["mode"];
}): boolean {
  return !isPackageManagerUpdateMode(params.updateMode);
}

type PostUpdateGatewayHealthRecoveryDeps = {
  recoverLaunchAgent?: typeof recoverInstalledLaunchAgentAfterUpdate;
  waitForHealthy?: typeof waitForGatewayHealthyRestart;
};

export async function recoverLaunchAgentAndRecheckGatewayHealth(params: {
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
  const launchAgentRecovery = await recoverLaunchAgent({
    service: params.service,
    env: params.env,
  });
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
  const restartCommand = replaceCliName(formatCliCommand("openclaw gateway restart"), CLI_NAME);
  const installCommand = replaceCliName(
    formatCliCommand("openclaw gateway install --force"),
    CLI_NAME,
  );
  const statusCommand = replaceCliName(
    formatCliCommand("openclaw gateway status --deep"),
    CLI_NAME,
  );
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
      `Rollback: reinstall OpenClaw ${beforeVersion} with the same package manager, then rerun \`${replaceCliName(formatCliCommand("openclaw gateway install --force"), CLI_NAME)}\`.`,
    );
  }
  return lines;
}
