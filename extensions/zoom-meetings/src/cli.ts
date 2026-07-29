import type { Command } from "commander";
import { callGatewayFromCli } from "openclaw/plugin-sdk/gateway-runtime";
import { MeetingPlatformAdapter } from "openclaw/plugin-sdk/meeting-runtime";
import { addTimerTimeoutGraceMs } from "openclaw/plugin-sdk/number-runtime";
import { zoomMeetingsConfig, type ZoomMeetingsConfig } from "./config.js";
import { zoomMeetingsInvalidRequest } from "./errors.js";

export function resolveZoomMeetingsCliGatewayTimeoutMs(
  config: ZoomMeetingsConfig,
  options: { probe: boolean; requestedTimeoutMs?: number },
): number {
  const operationTimeoutMs = zoomMeetingsConfig.resolveGatewayOperationTimeoutMs(config);
  const probeTimeoutMs = options.probe
    ? MeetingPlatformAdapter.resolveProbeTimeoutMs(
        options.requestedTimeoutMs,
        config.chrome.joinTimeoutMs,
        zoomMeetingsInvalidRequest,
      )
    : undefined;
  return probeTimeoutMs === undefined
    ? operationTimeoutMs
    : (addTimerTimeoutGraceMs(operationTimeoutMs, probeTimeoutMs) ?? 1);
}

export function registerZoomMeetingsCli(params: {
  program: Command;
  config: ZoomMeetingsConfig;
}): void {
  MeetingPlatformAdapter.registerPluginCli({
    ...params,
    callGateway: callGatewayFromCli,
    commandName: "zoommeetings",
    methodPrefix: "zoommeetings",
    descriptions: {
      root: "Join and manage Zoom meeting guests",
      join: "join a Zoom meeting as a guest",
      leave: "leave a Zoom meeting",
      status: "show Zoom meeting session status",
      setup: "check Zoom meeting prerequisites",
      testSpeech: "join and verify talk-back output",
      testListen: "join in transcribe mode and report caption support",
    },
    resolveGatewayTimeoutMs: ({ config, method, requestedTimeoutMs }) =>
      resolveZoomMeetingsCliGatewayTimeoutMs(config, {
        probe: method === "zoommeetings.testSpeech" || method === "zoommeetings.testListen",
        requestedTimeoutMs,
      }),
  });
}
