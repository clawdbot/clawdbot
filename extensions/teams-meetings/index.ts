import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import { MeetingPlatformAdapter } from "openclaw/plugin-sdk/meeting-runtime";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { normalizeAgentId } from "openclaw/plugin-sdk/routing";
import { Type } from "typebox";
import {
  resolveTeamsMeetingsConfig,
  resolveTeamsMeetingsGatewayOperationTimeoutMs,
  type TeamsMeetingsConfig,
} from "./src/config.js";
import { handleTeamsMeetingsNodeHostCommand } from "./src/node-host.js";
import { createTeamsMeetingsNodeInvokePolicy } from "./src/node-invoke-policy.js";
import { TeamsMeetingsRuntime } from "./src/runtime.js";
import { TEAMS_MEETINGS_NODE_COMMAND } from "./src/transports/teams-meetings-platform-constants.js";
import { normalizeTeamsMeetingUrl } from "./src/transports/teams-meetings-urls.js";
import type { TeamsMeetingsJoinRequest } from "./src/transports/types.js";

const loadTeamsMeetingsCli = createLazyRuntimeModule(() => import("./src/cli.js"));

const teamsMeetingsConfigSchema = {
  parse(value: unknown) {
    return resolveTeamsMeetingsConfig(value);
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

const TeamsMeetingsToolSchema = Type.Object({
  action: Type.String({ enum: ["join", "leave", "status", "transcript", "speak"] }),
  url: Type.Optional(Type.String({ description: "Microsoft Teams meeting URL" })),
  transport: Type.Optional(Type.String({ enum: ["chrome", "chrome-node"] })),
  mode: Type.Optional(Type.String({ enum: ["agent", "bidi", "transcribe"] })),
  sessionId: Type.Optional(Type.String({ description: "Teams meeting session ID" })),
  sinceIndex: Type.Optional(
    Type.Integer({ minimum: 0, description: "Resume transcript from this index" }),
  ),
  message: Type.Optional(Type.String({ description: "Instructions to speak" })),
});

class TeamsMeetingsInvalidRequestError extends Error {}

export default definePluginEntry(
  MeetingPlatformAdapter.createPluginEntry<
    TeamsMeetingsConfig,
    TeamsMeetingsJoinRequest,
    TeamsMeetingsRuntime
  >({
    id: "teams-meetings",
    name: "Microsoft Teams meetings",
    description: "Join Microsoft Teams meetings as a Chrome browser guest",
    configSchema: teamsMeetingsConfigSchema,
    disabledMessage: "Microsoft Teams meetings plugin disabled in plugin config",
    gatewayMethodPrefix: "teamsmeetings",
    invalidRequest: (message) => new TeamsMeetingsInvalidRequestError(message),
    isInvalidRequest: (error) => error instanceof TeamsMeetingsInvalidRequestError,
    normalizeUrl: normalizeTeamsMeetingUrl,
    resolveGatewayTimeoutMs: resolveTeamsMeetingsGatewayOperationTimeoutMs,
    normalizeRequesterSessionKey: (value) =>
      typeof value === "string" && value.trim() ? value.trim() : undefined,
    normalizeToolAgentId: (agentId) => (agentId ? normalizeAgentId(agentId) : undefined),
    resolveToolRuntime: async (api, agentId) => {
      const trustedRouting = Boolean(agentId && agentId !== "main");
      const useRuntime = trustedRouting ? await api.runtime.gateway.isAvailable() : false;
      if (trustedRouting && !useRuntime) {
        throw new Error(
          "Per-agent Microsoft Teams meeting routing requires a Gateway-hosted agent run.",
        );
      }
      return useRuntime ? api.runtime : undefined;
    },
    unknownActionMessage: "unknown teams_meetings action",
    toolName: "teams_meetings",
    toolLabel: "Microsoft Teams meetings",
    toolDescription:
      "Join and manage Microsoft Teams meeting browser guests. Guest admission, tenant sign-in, and media permissions may require manual action in the OpenClaw Chrome profile.",
    toolParameters: TeamsMeetingsToolSchema,
    transcriptSource: {
      id: "teams",
      aliases: ["teams-meetings", "microsoft-teams", "msteams"],
      name: "Microsoft Teams meetings",
    },
    createRuntime: ({ api, config }) =>
      new TeamsMeetingsRuntime({
        config,
        fullConfig: api.config,
        runtime: api.runtime,
        logger: api.logger,
      }),
    nodeCommand: TEAMS_MEETINGS_NODE_COMMAND,
    cap: "teams-meetings",
    nodeHandler: handleTeamsMeetingsNodeHostCommand,
    createNodePolicy: createTeamsMeetingsNodeInvokePolicy,
    registerNodeWhen: () => true,
    registerCli: (api, config) => {
      api.registerCli(
        async ({ program }) => {
          const cli = await loadTeamsMeetingsCli();
          cli.registerTeamsMeetingsCli({ program, config });
        },
        {
          commands: ["teamsmeetings"],
          descriptors: [
            {
              name: "teamsmeetings",
              description: "Join and manage Microsoft Teams meeting guests",
              hasSubcommands: true,
            },
          ],
        },
      );
    },
  }),
);
