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
  resolveZoomMeetingsConfig,
  resolveZoomMeetingsGatewayOperationTimeoutMs,
  type ZoomMeetingsConfig,
  type ZoomMeetingsMode,
  type ZoomMeetingsTransport,
} from "./src/config.js";
import {
  ZoomMeetingsInvalidRequestError,
  zoomMeetingsInvalidRequest as invalidRequest,
} from "./src/errors.js";
import { handleZoomMeetingsNodeHostCommand } from "./src/node-host.js";
import { createZoomMeetingsNodeInvokePolicy } from "./src/node-invoke-policy.js";
import { ZoomMeetingsRuntime } from "./src/runtime.js";
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

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function normalizeTransport(value: unknown): ZoomMeetingsTransport | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === "chrome" || value === "chrome-node") {
    return value;
  }
  throw invalidRequest("transport must be chrome or chrome-node");
}

function normalizeMode(value: unknown): ZoomMeetingsMode | undefined {
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

function keepTrustedToolContext(
  raw: Record<string, unknown>,
  client: GatewayRequestHandlerOptions["client"],
): Record<string, unknown> {
  const { agentId: rawAgentId, requesterSessionKey: rawRequesterSessionKey, ...rest } = raw;
  if (client?.internal?.pluginRuntimeOwnerId !== "zoom-meetings") {
    return rest;
  }
  const agentId = normalizeOptionalString(rawAgentId);
  const requesterSessionKey = normalizeOptionalString(rawRequesterSessionKey);
  return {
    ...rest,
    ...(agentId ? { agentId } : {}),
    ...(requesterSessionKey ? { requesterSessionKey } : {}),
  };
}

function trustedToolAgentId(
  raw: Record<string, unknown>,
  client: GatewayRequestHandlerOptions["client"],
): string | undefined {
  return normalizeOptionalString(keepTrustedToolContext(raw, client).agentId);
}

function joinRequest(raw: Record<string, unknown>, options?: { allowTimeout?: boolean }) {
  if (!options?.allowTimeout && raw.timeoutMs !== undefined) {
    throw invalidRequest("timeoutMs is supported only by testSpeech or testListen");
  }
  let url: string;
  let timeoutMs: number | undefined;
  try {
    url = normalizeZoomMeetingUrl(requireString(raw.url, "url"));
    timeoutMs = readPositiveIntegerParam(raw, "timeoutMs");
  } catch (error) {
    if (error instanceof ZoomMeetingsInvalidRequestError) {
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
  return `zoommeetings.${action}`;
}

function readErrorDetails(error: unknown): unknown {
  return error && typeof error === "object" && "details" in error
    ? (error as { details?: unknown }).details
    : undefined;
}

async function callGatewayFromTool(params: {
  action: ToolAction;
  config: ZoomMeetingsConfig;
  raw: Record<string, unknown>;
  runtime?: OpenClawPluginApi["runtime"];
}) {
  try {
    if (params.runtime) {
      return await params.runtime.gateway.request(gatewayMethod(params.action), params.raw, {
        timeoutMs: resolveZoomMeetingsGatewayOperationTimeoutMs(params.config),
        scopes: ["operator.admin"],
      });
    }
    return await callGatewayFromCli(
      gatewayMethod(params.action),
      {
        json: true,
        timeout: String(resolveZoomMeetingsGatewayOperationTimeoutMs(params.config)),
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
  id: "zoom-meetings",
  name: "Zoom meetings",
  description: "Join Zoom meetings as a Chrome browser guest",
  configSchema: zoomMeetingsConfigSchema,
  register(api: OpenClawPluginApi) {
    const config = zoomMeetingsConfigSchema.parse(api.pluginConfig);
    let runtime: ZoomMeetingsRuntime | undefined;

    const ensureRuntime = async () => {
      if (!config.enabled) {
        throw new Error("Zoom meetings plugin disabled in plugin config");
      }
      runtime ??= new ZoomMeetingsRuntime({
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
        error instanceof ZoomMeetingsInvalidRequestError
          ? ErrorCodes.INVALID_REQUEST
          : ErrorCodes.UNAVAILABLE,
      );

    api.registerGatewayMethod(
      "zoommeetings.join",
      async ({ params, client, respond }: GatewayRequestHandlerOptions) => {
        try {
          const raw = keepTrustedToolContext(asRecord(params), client);
          respond(true, await (await ensureRuntime()).join(joinRequest(raw)));
        } catch (error) {
          sendRequestError(respond, error);
        }
      },
    );

    api.registerGatewayMethod(
      "zoommeetings.leave",
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
      "zoommeetings.status",
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
      "zoommeetings.transcript",
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
      "zoommeetings.speak",
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
      "zoommeetings.setup",
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
        "zoommeetings.testSpeech",
        (rt: ZoomMeetingsRuntime, raw: Record<string, unknown>) =>
          rt.testSpeech(joinRequest(raw, { allowTimeout: true })),
      ],
      [
        "zoommeetings.testListen",
        (rt: ZoomMeetingsRuntime, raw: Record<string, unknown>) =>
          rt.testListen(joinRequest(raw, { allowTimeout: true })),
      ],
    ] as const) {
      api.registerGatewayMethod(
        method,
        async ({ params, client, respond }: GatewayRequestHandlerOptions) => {
          try {
            const raw = keepTrustedToolContext(asRecord(params), client);
            respond(true, await run(await ensureRuntime(), raw));
          } catch (error) {
            sendRequestError(respond, error);
          }
        },
      );
    }

    api.registerTool(
      (toolContext) => ({
        name: "zoom_meetings",
        label: "Zoom meetings",
        description:
          "Join and manage Zoom meeting browser guests. Guest admission, tenant sign-in, and media permissions may require manual action in the OpenClaw Chrome profile.",
        parameters: ZoomMeetingsToolSchema,
        async execute(_toolCallId, params) {
          const raw = asRecord(params);
          const action = raw.action as ToolAction;
          const requesterSessionKey = normalizeOptionalString(toolContext.sessionKey);
          const contextAgentId =
            toolContext.agentId ?? parseAgentSessionKey(requesterSessionKey)?.agentId;
          const agentId = normalizeAgentId(contextAgentId);
          try {
            if (!(["join", "leave", "status", "transcript", "speak"] as const).includes(action)) {
              throw new Error("unknown zoom_meetings action");
            }
            const useRuntime = await api.runtime.gateway.isAvailable();
            if (!useRuntime) {
              throw new Error("Zoom meeting tools require a Gateway-hosted agent run.");
            }
            return json(
              await callGatewayFromTool({
                action,
                config,
                raw: {
                  ...raw,
                  ...(requesterSessionKey ? { requesterSessionKey } : {}),
                  agentId,
                },
                runtime: api.runtime,
              }),
            );
          } catch (error) {
            return json({ error: formatErrorMessage(error) });
          }
        },
      }),
      { name: "zoom_meetings" },
    );

    if (config.enabled) {
      api.registerNodeHostCommand({
        command: ZOOM_MEETINGS_NODE_COMMAND,
        cap: "zoom-meetings",
        dangerous: true,
        handle: handleZoomMeetingsNodeHostCommand,
      });
      api.registerNodeInvokePolicy(createZoomMeetingsNodeInvokePolicy(config));
    }
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
});
