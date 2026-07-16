import type { GatewayServiceState } from "../../daemon/service-types.js";
import type { GatewayService } from "../../daemon/service.js";
import type { UpdateRunResult } from "../../infra/update-runner.js";
import type { GatewayRestartSnapshot } from "../daemon-cli/restart-health.js";
import "./update-command-service.js";

type PostUpdateLaunchAgentRecoveryResult =
  | { attempted: false; recovered: false }
  | { attempted: true; recovered: true; message: string }
  | { attempted: true; recovered: false; detail: string };

type UpdateCommandServiceTestApi = {
  formatPostUpdateGatewayRecoveryInstructions(
    result: UpdateRunResult,
    platform?: NodeJS.Platform,
  ): string[];
  recoverInstalledLaunchAgentAfterUpdate(params: {
    service?: GatewayService;
    env?: NodeJS.ProcessEnv;
    deps?: {
      platform?: NodeJS.Platform;
      readState?: (
        service: GatewayService,
        args: { env?: NodeJS.ProcessEnv },
      ) => Promise<GatewayServiceState>;
      recover?: (params: {
        result: "restarted";
        env?: Record<string, string | undefined>;
      }) => Promise<{ result: "restarted"; loaded: true; message: string } | null>;
    };
  }): Promise<PostUpdateLaunchAgentRecoveryResult>;
  recoverLaunchAgentAndRecheckGatewayHealth(params: {
    health: GatewayRestartSnapshot;
    service: GatewayService;
    port: number;
    expectedVersion?: string;
    env?: NodeJS.ProcessEnv;
    deps?: {
      recoverLaunchAgent?: (params: {
        service?: GatewayService;
        env?: NodeJS.ProcessEnv;
      }) => Promise<PostUpdateLaunchAgentRecoveryResult>;
      waitForHealthy?: (params: {
        service: GatewayService;
        port: number;
        expectedVersion?: string;
        env?: NodeJS.ProcessEnv;
      }) => Promise<GatewayRestartSnapshot>;
    };
  }): Promise<{
    health: GatewayRestartSnapshot;
    launchAgentRecovery: PostUpdateLaunchAgentRecoveryResult | null;
  }>;
  shouldUseLegacyProcessRestartAfterUpdate(params: {
    updateMode: UpdateRunResult["mode"];
  }): boolean;
};

function getTestApi(): UpdateCommandServiceTestApi {
  return (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.updateCommandServiceTestApi")
  ] as UpdateCommandServiceTestApi;
}

export function formatPostUpdateGatewayRecoveryInstructions(
  result: UpdateRunResult,
  platform?: NodeJS.Platform,
): string[] {
  return getTestApi().formatPostUpdateGatewayRecoveryInstructions(result, platform);
}

export async function recoverInstalledLaunchAgentAfterUpdate(
  params: Parameters<UpdateCommandServiceTestApi["recoverInstalledLaunchAgentAfterUpdate"]>[0],
): Promise<PostUpdateLaunchAgentRecoveryResult> {
  return await getTestApi().recoverInstalledLaunchAgentAfterUpdate(params);
}

export async function recoverLaunchAgentAndRecheckGatewayHealth(
  params: Parameters<UpdateCommandServiceTestApi["recoverLaunchAgentAndRecheckGatewayHealth"]>[0],
) {
  return await getTestApi().recoverLaunchAgentAndRecheckGatewayHealth(params);
}

export function shouldUseLegacyProcessRestartAfterUpdate(
  params: Parameters<UpdateCommandServiceTestApi["shouldUseLegacyProcessRestartAfterUpdate"]>[0],
): boolean {
  return getTestApi().shouldUseLegacyProcessRestartAfterUpdate(params);
}
