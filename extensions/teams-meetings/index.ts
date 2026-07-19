import {
  readNonNegativeIntegerParam,
  readPositiveIntegerParam,
} from "openclaw/plugin-sdk/channel-actions";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  callGatewayFromCli,
  ErrorCodes,
  errorShape,
  type GatewayRequestHandlerOptions,
} from "openclaw/plugin-sdk/gateway-runtime";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import { definePluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { normalizeAgentId, parseAgentSessionKey } from "openclaw/plugin-sdk/routing";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { jsonResult as json } from "openclaw/plugin-sdk/tool-results";
import { Type } from "typebox";
import {
  resolveTeamsMeetingsConfig,
  resolveTeamsMeetingsGatewayOperationTimeoutMs,
  type TeamsMeetingsConfig,
  type TeamsMeetingsMode,
  type TeamsMeetingsTransport,
} from "./src/config.js";
import { handleTeamsMeetingsNodeHostCommand } from "./src/node-host.js";
import { createTeamsMeetingsNodeInvokePolicy } from "./src/node-invoke-policy.js";
import { TeamsMeetingsRuntime } from "./src/runtime.js";
import { TEAMS_MEETINGS_NODE_COMMAND } from "./src/transports/teams-meetings-platform-constants.js";
import { normalizeTeamsMeetingUrl } from "./src/transports/teams-meetings-urls.js";

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

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

class TeamsMeetingsInvalidRequestError extends Error {}

function invalidRequest(message: string): TeamsMeetingsInvalidRequestError {
  return new TeamsMeetingsInvalidRequestError(message);
}

function normalizeTransport(value: unknown): TeamsMeetingsTransport | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === "chrome" || value === "chrome-node") {
    return value;
  }
  throw invalidRequest("transport must be chrome or chrome-node");
}

function normalizeMode(value: unknown): TeamsMeetingsMode | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === "agent" || value === "bidi" || value === "transcribe") {
    return value;
  }
  throw invalidRequest("mode must be agent, bidi, or transcribe");
}

function requireString(value: unknown, name: string): string {
  const normalized = normalizeOptionalString(value);
  if (!normalized) {
    throw invalidRequest(`${name} required`);
  }
  return normalized;
}

function readSinceIndex(raw: Record<string, unknown>): number | undefined {
  try {
    return readNonNegativeIntegerParam(raw, "sinceIndex");
  } catch (error) {
    throw invalidRequest(formatErrorMessage(error));
  }
}

function keepTrustedToolAgentId(
  raw: Record<string, unknown>,
  client: GatewayRequestHandlerOptions["client"],
): Record<string, unknown> {
  const { agentId: rawAgentId, ...rest } = raw;
  if (client?.internal?.pluginRuntimeOwnerId !== "teams-meetings") {
    return rest;
  }
  const agentId = normalizeOptionalString(rawAgentId);
  return agentId ? { ...rest, agentId } : rest;
}

function trustedToolAgentId(
  raw: Record<string, unknown>,
  client: GatewayRequestHandlerOptions["client"],
): string | undefined {
  return normalizeOptionalString(keepTrustedToolAgentId(raw, client).agentId);
}

function joinRequest(raw: Record<string, unknown>, options?: { allowTimeout?: boolean }) {
  if (!options?.allowTimeout && raw.timeoutMs !== undefined) {
    throw invalidRequest("timeoutMs is supported only by testSpeech or testListen");
  }
  let url: string;
  let timeoutMs: number | undefined;
  try {
    url = normalizeTeamsMeetingUrl(requireString(raw.url, "url"));
    timeoutMs = readPositiveIntegerParam(raw, "timeoutMs");
  } catch (error) {
    if (error instanceof TeamsMeetingsInvalidRequestError) {
      throw error;
    }
    throw invalidRequest(formatErrorMessage(error));
  }
  return {
    url,
    transport: normalizeTransport(raw.transport),
    mode: normalizeMode(raw.mode),
    message: normalizeOptionalString(raw.message),
    requesterSessionKey: normalizeOptionalString(raw.requesterSessionKey),
    agentId: normalizeOptionalString(raw.agentId),
    timeoutMs,
  };
}

type ToolAction = "join" | "leave" | "status" | "transcript" | "speak";

function gatewayMethod(action: ToolAction): string {
  return `teamsmeetings.${action}`;
}

function readErrorDetails(error: unknown): unknown {
  return error && typeof error === "object" && "details" in error
    ? (error as { details?: unknown }).details
    : undefined;
}

async function callGatewayFromTool(params: {
  action: ToolAction;
  config: TeamsMeetingsConfig;
  raw: Record<string, unknown>;
  runtime?: OpenClawPluginApi["runtime"];
}) {
  try {
    if (params.runtime) {
      return await params.runtime.gateway.request(gatewayMethod(params.action), params.raw, {
        timeoutMs: resolveTeamsMeetingsGatewayOperationTimeoutMs(params.config),
        scopes: ["operator.admin"],
      });
    }
    return await callGatewayFromCli(
      gatewayMethod(params.action),
      {
        json: true,
        timeout: String(resolveTeamsMeetingsGatewayOperationTimeoutMs(params.config)),
      },
      params.raw,
      { progress: false, scopes: ["operator.admin"] },
    );
  } catch (error) {
    const details = readErrorDetails(error);
    if (details && typeof details === "object") {
      return details;
    }
    throw error;
  }
}

export default definePluginEntry({
  id: "teams-meetings",
  name: "Microsoft Teams meetings",
  description: "Join Microsoft Teams meetings as a Chrome browser guest",
  configSchema: teamsMeetingsConfigSchema,
  register(api: OpenClawPluginApi) {
    const config = teamsMeetingsConfigSchema.parse(api.pluginConfig);
    let runtime: TeamsMeetingsRuntime | undefined;

    const ensureRuntime = async () => {
      if (!config.enabled) {
        throw new Error("Microsoft Teams meetings plugin disabled in plugin config");
      }
      runtime ??= new TeamsMeetingsRuntime({
        config,
        fullConfig: api.config,
        runtime: api.runtime,
        logger: api.logger,
      });
      return runtime;
    };

    const sendError = (
      respond: GatewayRequestHandlerOptions["respond"],
      error: unknown,
      code: Parameters<typeof errorShape>[0] = ErrorCodes.UNAVAILABLE,
    ) => {
      const payload = { error: formatErrorMessage(error) };
      respond(false, payload, errorShape(code, payload.error, { details: payload }));
    };
    const sendRequestError = (respond: GatewayRequestHandlerOptions["respond"], error: unknown) =>
      sendError(
        respond,
        error,
        error instanceof TeamsMeetingsInvalidRequestError
          ? ErrorCodes.INVALID_REQUEST
          : ErrorCodes.UNAVAILABLE,
      );

    api.registerGatewayMethod(
      "teamsmeetings.join",
      async ({ params, client, respond }: GatewayRequestHandlerOptions) => {
        try {
          const raw = keepTrustedToolAgentId(asRecord(params), client);
          respond(true, await (await ensureRuntime()).join(joinRequest(raw)));
        } catch (error) {
          sendRequestError(respond, error);
        }
      },
    );

    api.registerGatewayMethod(
      "teamsmeetings.leave",
      async ({ params, client, respond }: GatewayRequestHandlerOptions) => {
        try {
          const raw = asRecord(params);
          const agentId = trustedToolAgentId(raw, client);
          const sessionId = requireString(raw.sessionId, "sessionId");
          const rt = await ensureRuntime();
          respond(
            true,
            agentId && !rt.ownsSession(agentId, sessionId)
              ? { found: false }
              : await rt.leave(sessionId),
          );
        } catch (error) {
          sendRequestError(respond, error);
        }
      },
    );

    api.registerGatewayMethod(
      "teamsmeetings.status",
      async ({ params, client, respond }: GatewayRequestHandlerOptions) => {
        try {
          const raw = asRecord(params);
          const agentId = trustedToolAgentId(raw, client);
          const rt = await ensureRuntime();
          respond(
            true,
            agentId
              ? await rt.statusForAgent(agentId, normalizeOptionalString(raw.sessionId))
              : await rt.status(normalizeOptionalString(raw.sessionId)),
          );
        } catch (error) {
          sendRequestError(respond, error);
        }
      },
    );

    api.registerGatewayMethod(
      "teamsmeetings.transcript",
      async ({ params, client, respond }: GatewayRequestHandlerOptions) => {
        try {
          const raw = asRecord(params);
          const sessionId = requireString(raw.sessionId, "sessionId");
          const sinceIndex = readSinceIndex(raw);
          const agentId = trustedToolAgentId(raw, client);
          const rt = await ensureRuntime();
          respond(
            true,
            agentId && !rt.ownsSession(agentId, sessionId)
              ? { found: false }
              : await rt.transcript(sessionId, sinceIndex === undefined ? {} : { sinceIndex }),
          );
        } catch (error) {
          sendRequestError(respond, error);
        }
      },
    );

    api.registerGatewayMethod(
      "teamsmeetings.speak",
      async ({ params, client, respond }: GatewayRequestHandlerOptions) => {
        try {
          const raw = asRecord(params);
          const sessionId = requireString(raw.sessionId, "sessionId");
          const agentId = trustedToolAgentId(raw, client);
          const rt = await ensureRuntime();
          respond(
            true,
            agentId && !rt.ownsSession(agentId, sessionId)
              ? { found: false, spoken: false }
              : await rt.speak(sessionId, normalizeOptionalString(raw.message)),
          );
        } catch (error) {
          sendRequestError(respond, error);
        }
      },
    );

    api.registerGatewayMethod(
      "teamsmeetings.setup",
      async ({ params, respond }: GatewayRequestHandlerOptions) => {
        try {
          respond(
            true,
            await (
              await ensureRuntime()
            ).setupStatus({
              mode: normalizeMode(params?.mode),
              transport: normalizeTransport(params?.transport),
            }),
          );
        } catch (error) {
          sendRequestError(respond, error);
        }
      },
    );

    for (const [method, run] of [
      [
        "teamsmeetings.testSpeech",
        (rt: TeamsMeetingsRuntime, raw: Record<string, unknown>) =>
          rt.testSpeech(joinRequest(raw, { allowTimeout: true })),
      ],
      [
        "teamsmeetings.testListen",
        (rt: TeamsMeetingsRuntime, raw: Record<string, unknown>) =>
          rt.testListen(joinRequest(raw, { allowTimeout: true })),
      ],
    ] as const) {
      api.registerGatewayMethod(
        method,
        async ({ params, client, respond }: GatewayRequestHandlerOptions) => {
          try {
            const raw = keepTrustedToolAgentId(asRecord(params), client);
            respond(true, await run(await ensureRuntime(), raw));
          } catch (error) {
            sendRequestError(respond, error);
          }
        },
      );
    }

    api.registerTool(
      (toolContext) => ({
        name: "teams_meetings",
        label: "Microsoft Teams meetings",
        description:
          "Join and manage Microsoft Teams meeting browser guests. Guest admission, tenant sign-in, and media permissions may require manual action in the OpenClaw Chrome profile.",
        parameters: TeamsMeetingsToolSchema,
        async execute(_toolCallId, params) {
          const raw = asRecord(params);
          const action = raw.action as ToolAction;
          const requesterSessionKey = normalizeOptionalString(toolContext.sessionKey);
          const contextAgentId =
            toolContext.agentId ?? parseAgentSessionKey(requesterSessionKey)?.agentId;
          const agentId = contextAgentId ? normalizeAgentId(contextAgentId) : undefined;
          try {
            if (!(["join", "leave", "status", "transcript", "speak"] as const).includes(action)) {
              throw new Error("unknown teams_meetings action");
            }
            const trustedRouting = Boolean(agentId && agentId !== "main");
            const useRuntime = trustedRouting ? await api.runtime.gateway.isAvailable() : false;
            if (trustedRouting && !useRuntime) {
              throw new Error(
                "Per-agent Microsoft Teams meeting routing requires a Gateway-hosted agent run.",
              );
            }
            return json(
              await callGatewayFromTool({
                action,
                config,
                raw: {
                  ...raw,
                  ...(requesterSessionKey ? { requesterSessionKey } : {}),
                  ...(useRuntime ? { agentId } : {}),
                },
                runtime: useRuntime ? api.runtime : undefined,
              }),
            );
          } catch (error) {
            return json({ error: formatErrorMessage(error) });
          }
        },
      }),
      { name: "teams_meetings" },
    );

    api.registerNodeHostCommand({
      command: TEAMS_MEETINGS_NODE_COMMAND,
      cap: "teams-meetings",
      dangerous: true,
      handle: handleTeamsMeetingsNodeHostCommand,
    });
    api.registerNodeInvokePolicy(createTeamsMeetingsNodeInvokePolicy(config));
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
});
