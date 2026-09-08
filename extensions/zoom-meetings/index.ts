import { MeetingPlatformAdapter } from "openclaw/plugin-sdk/meeting-runtime";
import { normalizeAgentId } from "openclaw/plugin-sdk/routing";
import { Type } from "typebox";
import { ZOOM_MEETINGS_CLI_METADATA } from "./src/cli-output-mode.js";
import { zoomMeetingsConfig } from "./src/config.js";
import { ZoomMeetingsInvalidRequestError, zoomMeetingsInvalidRequest } from "./src/errors.js";
import { handleZoomMeetingsNodeHostCommand } from "./src/node-host.js";
import { createZoomMeetingsNodeInvokePolicy } from "./src/node-invoke-policy.js";
import { ZoomMeetingsRuntime } from "./src/runtime.js";
import { ZOOM_MEETINGS_PLATFORM_ADAPTER } from "./src/transports/zoom-meetings-platform-adapter.js";

export default MeetingPlatformAdapter.createPluginShellEntry({
  platform: ZOOM_MEETINGS_PLATFORM_ADAPTER,
  browserGuestLabel: "Zoom meeting",
  configSchema: zoomMeetingsConfig.configSchema,
  invalidRequest: zoomMeetingsInvalidRequest,
  isInvalidRequest: (error) => error instanceof ZoomMeetingsInvalidRequestError,
  toolParameters: Type.Object({
    action: Type.String({ enum: ["join", "leave", "status", "transcript", "speak"] }),
    url: Type.Optional(Type.String({ description: "Zoom meeting URL" })),
    transport: Type.Optional(Type.String({ enum: ["chrome", "chrome-node"] })),
    mode: Type.Optional(Type.String({ enum: ["agent", "bidi", "transcribe"] })),
    sessionId: Type.Optional(Type.String({ description: "Zoom meeting session ID" })),
    sinceIndex: Type.Optional(
      Type.Integer({ minimum: 0, description: "Resume transcript from this index" }),
    ),
    message: Type.Optional(Type.String({ description: "Instructions to speak" })),
  }),
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
    descriptor: ZOOM_MEETINGS_CLI_METADATA.descriptor,
    load: async () => (await import("./src/cli.js")).registerZoomMeetingsCli,
  },
});
