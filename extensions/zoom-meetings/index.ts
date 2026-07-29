import { MeetingPlatformAdapter } from "openclaw/plugin-sdk/meeting-runtime";
import { normalizeAgentId } from "openclaw/plugin-sdk/routing";
import { zoomMeetingsConfig } from "./src/config.js";
import { ZoomMeetingsInvalidRequestError, zoomMeetingsInvalidRequest } from "./src/errors.js";
import { handleZoomMeetingsNodeHostCommand } from "./src/node-host.js";
import { createZoomMeetingsNodeInvokePolicy } from "./src/node-invoke-policy.js";
import { ZoomMeetingsRuntime } from "./src/runtime.js";
import { ZOOM_MEETINGS_PLATFORM_ADAPTER } from "./src/transports/zoom-meetings-platform-adapter.js";

export default MeetingPlatformAdapter.createPluginShellEntry({
  platform: ZOOM_MEETINGS_PLATFORM_ADAPTER,
  browserGuestLabel: "Zoom meeting",
  sessionLabel: "Zoom meeting",
  configSchema: zoomMeetingsConfig.configSchema,
  invalidRequest: zoomMeetingsInvalidRequest,
  isInvalidRequest: (error) => error instanceof ZoomMeetingsInvalidRequestError,
  resolveGatewayTimeoutMs: zoomMeetingsConfig.resolveGatewayOperationTimeoutMs,
  normalizeRequesterSessionKey: (value, trustedOwner) =>
    trustedOwner && typeof value === "string" && value.trim() ? value.trim() : undefined,
  normalizeToolAgentId: (agentId) => normalizeAgentId(agentId),
  resolveToolRuntime: async (api) => {
    if (!(await api.runtime.gateway.isAvailable())) {
      throw new Error("Zoom meeting tools require a Gateway-hosted agent run.");
    }
    return api.runtime;
  },
  transcriptSource: { id: "zoom", aliases: ["zoom-meetings"] },
  runtime: ZoomMeetingsRuntime,
  nodeHandler: handleZoomMeetingsNodeHostCommand,
  createNodePolicy: createZoomMeetingsNodeInvokePolicy,
  registerNodeWhen: (config) => config.enabled,
  cli: {
    load: async () => (await import("./src/cli.js")).registerZoomMeetingsCli,
  },
});
