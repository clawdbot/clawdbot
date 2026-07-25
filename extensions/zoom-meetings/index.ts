import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import { MeetingPlatformAdapter } from "openclaw/plugin-sdk/meeting-runtime";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { normalizeAgentId } from "openclaw/plugin-sdk/routing";
import { Type } from "typebox";
import {
  resolveZoomMeetingsConfig,
  resolveZoomMeetingsGatewayOperationTimeoutMs,
  type ZoomMeetingsConfig,
} from "./src/config.js";
import { ZoomMeetingsInvalidRequestError, zoomMeetingsInvalidRequest } from "./src/errors.js";
import { handleZoomMeetingsNodeHostCommand } from "./src/node-host.js";
import { createZoomMeetingsNodeInvokePolicy } from "./src/node-invoke-policy.js";
import { ZoomMeetingsRuntime } from "./src/runtime.js";
import type { ZoomMeetingsJoinRequest } from "./src/transports/types.js";
import { ZOOM_MEETINGS_NODE_COMMAND } from "./src/transports/zoom-meetings-platform-constants.js";
import { normalizeZoomMeetingUrl } from "./src/transports/zoom-meetings-urls.js";

const loadZoomMeetingsCli = createLazyRuntimeModule(() => import("./src/cli.js"));

const zoomMeetingsConfigSchema = {
  parse(value: unknown) {
    return resolveZoomMeetingsConfig(value);
  },
  uiHints: {
    defaultMode: {
      label: "Default Mode",
      help: "Agent consults OpenClaw, bidi uses direct realtime voice, and transcribe observes only.",
    },
    "chrome.browserProfile": { label: "Chrome Profile", advanced: true },
    "chrome.guestName": { label: "Guest Name" },
    "chrome.waitForInCallMs": { label: "Wait For In-Call (ms)", advanced: true },
    "chrome.audioInputCommand": { label: "Audio Input Command", advanced: true },
    "chrome.audioOutputCommand": { label: "Audio Output Command", advanced: true },
    "chromeNode.node": {
      label: "Chrome Node",
      help: "Node id/name/IP that owns Chrome, BlackHole, and SoX.",
      advanced: true,
    },
    "realtime.transcriptionProvider": { label: "Realtime Transcription Provider" },
    "realtime.voiceProvider": { label: "Bidi Voice Provider" },
    "realtime.model": { label: "Bidi Realtime Model", advanced: true },
    "realtime.instructions": { label: "Realtime Instructions", advanced: true },
    "realtime.introMessage": { label: "Realtime Intro Message" },
    "realtime.agentId": { label: "Realtime Consult Agent", advanced: true },
    "realtime.toolPolicy": { label: "Realtime Tool Policy", advanced: true },
  },
};

const ZoomMeetingsToolSchema = Type.Object({
  action: Type.String({ enum: ["join", "leave", "status", "transcript", "speak"] }),
  url: Type.Optional(Type.String({ description: "Zoom meeting URL" })),
  transport: Type.Optional(Type.String({ enum: ["chrome", "chrome-node"] })),
  mode: Type.Optional(Type.String({ enum: ["agent", "bidi", "transcribe"] })),
  sessionId: Type.Optional(Type.String({ description: "Zoom meeting session ID" })),
  sinceIndex: Type.Optional(
    Type.Integer({ minimum: 0, description: "Resume transcript from this index" }),
  ),
  message: Type.Optional(Type.String({ description: "Instructions to speak" })),
});

export default definePluginEntry(
  MeetingPlatformAdapter.createPluginEntry<
    ZoomMeetingsConfig,
    ZoomMeetingsJoinRequest,
    ZoomMeetingsRuntime
  >({
    id: "zoom-meetings",
    name: "Zoom meetings",
    description: "Join Zoom meetings as a Chrome browser guest",
    configSchema: zoomMeetingsConfigSchema,
    disabledMessage: "Zoom meetings plugin disabled in plugin config",
    gatewayMethodPrefix: "zoommeetings",
    invalidRequest: zoomMeetingsInvalidRequest,
    isInvalidRequest: (error) => error instanceof ZoomMeetingsInvalidRequestError,
    normalizeUrl: normalizeZoomMeetingUrl,
    resolveGatewayTimeoutMs: resolveZoomMeetingsGatewayOperationTimeoutMs,
    normalizeRequesterSessionKey: (value, trustedOwner) =>
      trustedOwner && typeof value === "string" && value.trim() ? value.trim() : undefined,
    normalizeToolAgentId: (agentId) => normalizeAgentId(agentId),
    resolveToolRuntime: async (api) => {
      if (!(await api.runtime.gateway.isAvailable())) {
        throw new Error("Zoom meeting tools require a Gateway-hosted agent run.");
      }
      return api.runtime;
    },
    unknownActionMessage: "unknown zoom_meetings action",
    toolName: "zoom_meetings",
    toolLabel: "Zoom meetings",
    toolDescription:
      "Join and manage Zoom meeting browser guests. Guest admission, tenant sign-in, and media permissions may require manual action in the OpenClaw Chrome profile.",
    toolParameters: ZoomMeetingsToolSchema,
    transcriptSource: {
      id: "zoom",
      aliases: ["zoom-meetings"],
      name: "Zoom meetings",
    },
    createRuntime: ({ api, config }) =>
      new ZoomMeetingsRuntime({
        config,
        fullConfig: api.config,
        runtime: api.runtime,
        logger: api.logger,
      }),
    nodeCommand: ZOOM_MEETINGS_NODE_COMMAND,
    cap: "zoom-meetings",
    nodeHandler: handleZoomMeetingsNodeHostCommand,
    createNodePolicy: createZoomMeetingsNodeInvokePolicy,
    registerNodeWhen: (config) => config.enabled,
    registerCli: (api, config) => {
      api.registerCli(
        async ({ program }) => {
          const cli = await loadZoomMeetingsCli();
          cli.registerZoomMeetingsCli({ program, config });
        },
        {
          commands: ["zoommeetings"],
          descriptors: [
            {
              name: "zoommeetings",
              description: "Join and manage Zoom meeting guests",
              hasSubcommands: true,
            },
          ],
        },
      );
    },
  }),
);
