import { MeetingPlatformAdapter } from "openclaw/plugin-sdk/meeting-runtime";
import { normalizeAgentId } from "openclaw/plugin-sdk/routing";
import { Type } from "typebox";
import { teamsMeetingsConfig } from "./src/config.js";
import { handleTeamsMeetingsNodeHostCommand } from "./src/node-host.js";
import { createTeamsMeetingsNodeInvokePolicy } from "./src/node-invoke-policy.js";
import { TeamsMeetingsRuntime } from "./src/runtime.js";
import { TEAMS_MEETINGS_PLATFORM_ADAPTER } from "./src/transports/teams-meetings-platform-adapter.js";

class TeamsMeetingsInvalidRequestError extends Error {}

export default MeetingPlatformAdapter.createPluginShellEntry({
  platform: TEAMS_MEETINGS_PLATFORM_ADAPTER,
  browserGuestLabel: "Microsoft Teams meeting",
  configSchema: teamsMeetingsConfig.configSchema,
  invalidRequest: (message) => new TeamsMeetingsInvalidRequestError(message),
  isInvalidRequest: (error) => error instanceof TeamsMeetingsInvalidRequestError,
  toolParameters: Type.Object({
    action: Type.String({ enum: ["join", "leave", "status", "transcript", "speak"] }),
    url: Type.Optional(Type.String({ description: "Microsoft Teams meeting URL" })),
    transport: Type.Optional(Type.String({ enum: ["chrome", "chrome-node"] })),
    mode: Type.Optional(Type.String({ enum: ["agent", "bidi", "transcribe"] })),
    sessionId: Type.Optional(Type.String({ description: "Teams meeting session ID" })),
    sinceIndex: Type.Optional(
      Type.Integer({ minimum: 0, description: "Resume transcript from this index" }),
    ),
    message: Type.Optional(Type.String({ description: "Instructions to speak" })),
  }),
  resolveGatewayTimeoutMs: teamsMeetingsConfig.resolveGatewayOperationTimeoutMs,
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
  transcriptSource: {
    id: "teams",
    aliases: ["teams-meetings", "microsoft-teams", "msteams"],
  },
  runtime: TeamsMeetingsRuntime,
  nodeHandler: handleTeamsMeetingsNodeHostCommand,
  createNodePolicy: createTeamsMeetingsNodeInvokePolicy,
  registerNodeWhen: () => true,
  cli: {
    load: async () => (await import("./src/cli.js")).registerTeamsMeetingsCli,
  },
});
