import type { Command } from "commander";
import { callGatewayFromCli } from "openclaw/plugin-sdk/gateway-runtime";
import { MeetingPlatformAdapter } from "openclaw/plugin-sdk/meeting-runtime";
import { addTimerTimeoutGraceMs } from "openclaw/plugin-sdk/number-runtime";
import { teamsMeetingsConfig, type TeamsMeetingsConfig } from "./config.js";

export function registerTeamsMeetingsCli(params: {
  program: Command;
  config: TeamsMeetingsConfig;
}): void {
  MeetingPlatformAdapter.registerPluginCli({
    ...params,
    callGateway: callGatewayFromCli,
    commandName: "teamsmeetings",
    methodPrefix: "teamsmeetings",
    descriptions: {
      root: "Join and manage Microsoft Teams meeting guests",
      join: "join a Teams meeting as a guest",
      leave: "leave a Teams meeting",
      status: "show Teams meeting session status",
      setup: "check Teams meeting prerequisites",
      testSpeech: "join and verify talk-back output",
      testListen: "join in transcribe mode and report caption support",
    },
    resolveGatewayTimeoutMs: ({ config, requestedTimeoutMs }) =>
      Math.max(
        teamsMeetingsConfig.resolveGatewayOperationTimeoutMs(config),
        requestedTimeoutMs === undefined
          ? 0
          : (addTimerTimeoutGraceMs(requestedTimeoutMs, 30_000) ?? 1),
      ),
  });
}
