import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { TObject } from "typebox";
import { ErrorCodes, errorShape } from "../../packages/gateway-protocol/src/schema/error-codes.js";
import { readNonNegativeIntegerParam, readPositiveIntegerParam } from "../agents/tools/common.js";
import { jsonResult } from "../agents/tools/common.js";
import { callGatewayFromCli } from "../cli/gateway-rpc.js";
import type { GatewayRequestHandlerOptions } from "../gateway/server-methods/types.js";
import { formatErrorMessage } from "../infra/errors.js";
import type { OpenClawPluginApi } from "../plugins/plugin-api.types.js";
import type { OpenClawPluginConfigSchema } from "../plugins/plugin-config-schema.types.js";
import type { OpenClawPluginNodeInvokePolicy } from "../plugins/plugin-registration.types.js";
import { parseAgentSessionKey } from "../sessions/session-key-utils.js";
import {
  createMeetingTranscriptSourceProvider,
  type MeetingTranscriptSourceRuntime,
} from "./transcripts-bridge.js";

type MeetingToolAction = "join" | "leave" | "status" | "transcript" | "speak";
type MeetingMode = "agent" | "bidi" | "transcribe";
type MeetingTransport = "chrome" | "chrome-node";

type MeetingJoinRequest = {
  agentId?: string;
  message?: string;
  mode?: MeetingMode;
  requesterSessionKey?: string;
  timeoutMs?: number;
  transport?: MeetingTransport;
  url: string;
};

type MeetingPluginConfig = {
  enabled: boolean;
  chromeNode: { node?: string };
};

type MeetingPluginRuntime<Request extends MeetingJoinRequest> =
  Partial<MeetingTranscriptSourceRuntime> & {
    join(request: Request): Promise<unknown>;
    leave(sessionId: string): Promise<unknown>;
    ownsSession(agentId: string, sessionId: string): boolean;
    setupStatus(params: { mode?: MeetingMode; transport?: MeetingTransport }): Promise<unknown>;
    speak(sessionId: string, message?: string): Promise<unknown>;
    status(sessionId?: string): Promise<unknown>;
    statusForAgent(agentId: string, sessionId?: string): Promise<unknown>;
    testListen(request: Request): Promise<unknown>;
    testSpeech(request: Request): Promise<unknown>;
    transcript(sessionId: string, options: { sinceIndex?: number }): Promise<unknown>;
  };

type MeetingPluginEntryOptions<
  Config extends MeetingPluginConfig,
  Request extends MeetingJoinRequest,
  Runtime extends MeetingPluginRuntime<Request>,
> = {
  cap: string;
  configSchema: OpenClawPluginConfigSchema & { parse(value: unknown): Config };
  createNodePolicy(config: Config): OpenClawPluginNodeInvokePolicy;
  createRuntime(params: { api: OpenClawPluginApi; config: Config }): Runtime;
  description: string;
  disabledMessage: string;
  gatewayMethodPrefix: string;
  id: string;
  invalidRequest(message: string): Error;
  isInvalidRequest(error: unknown): boolean;
  name: string;
  nodeCommand: string;
  nodeHandler(paramsJSON?: string | null): Promise<string>;
  normalizeRequesterSessionKey(value: unknown, trustedOwner: boolean): string | undefined;
  normalizeToolAgentId(agentId: string | undefined): string | undefined;
  normalizeUrl(url: string): string;
  registerCli(api: OpenClawPluginApi, config: Config): void;
  registerNodeWhen(config: Config): boolean;
  resolveGatewayTimeoutMs(config: Config): number;
  resolveToolRuntime(
    api: OpenClawPluginApi,
    agentId: string | undefined,
  ): Promise<OpenClawPluginApi["runtime"] | undefined>;
  toolDescription: string;
  toolLabel: string;
  toolName: string;
  toolParameters: TObject;
  transcriptSource?: {
    id: string;
    aliases?: readonly string[];
    name: string;
  };
  unknownActionMessage: string;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readErrorDetails(error: unknown): unknown {
  return error && typeof error === "object" && "details" in error
    ? (error as { details?: unknown }).details
    : undefined;
}

export function createMeetingPluginEntryOptions<
  Config extends MeetingPluginConfig,
  Request extends MeetingJoinRequest,
  Runtime extends MeetingPluginRuntime<Request>,
>(options: MeetingPluginEntryOptions<Config, Request, Runtime>) {
  const invalidRequest = (message: string): never => {
    throw options.invalidRequest(message);
  };
  const normalizeTransport = (value: unknown): MeetingTransport | undefined => {
    if (value === undefined) {
      return undefined;
    }
    if (value === "chrome" || value === "chrome-node") {
      return value;
    }
    return invalidRequest("transport must be chrome or chrome-node");
  };
  const normalizeMode = (value: unknown): MeetingMode | undefined => {
    if (value === undefined) {
      return undefined;
    }
    if (value === "agent" || value === "bidi" || value === "transcribe") {
      return value;
    }
    return invalidRequest("mode must be agent, bidi, or transcribe");
  };
  const requireString = (value: unknown, name: string): string => {
    const normalized = normalizeOptionalString(value);
    return normalized ?? invalidRequest(`${name} required`);
  };
  const readSinceIndex = (raw: Record<string, unknown>): number | undefined => {
    try {
      return readNonNegativeIntegerParam(raw, "sinceIndex");
    } catch (error) {
      return invalidRequest(formatErrorMessage(error));
    }
  };
  const keepTrustedToolContext = (
    raw: Record<string, unknown>,
    client: GatewayRequestHandlerOptions["client"],
  ): Record<string, unknown> => {
    const { agentId: rawAgentId, requesterSessionKey: rawRequesterSessionKey, ...rest } = raw;
    const trustedOwner = client?.internal?.pluginRuntimeOwnerId === options.id;
    const agentId = trustedOwner ? normalizeOptionalString(rawAgentId) : undefined;
    const requesterSessionKey = options.normalizeRequesterSessionKey(
      rawRequesterSessionKey,
      trustedOwner,
    );
    return {
      ...rest,
      ...(agentId ? { agentId } : {}),
      ...(requesterSessionKey ? { requesterSessionKey } : {}),
    };
  };
  const trustedToolAgentId = (
    raw: Record<string, unknown>,
    client: GatewayRequestHandlerOptions["client"],
  ) => normalizeOptionalString(keepTrustedToolContext(raw, client).agentId);
  const joinRequest = (
    raw: Record<string, unknown>,
    joinOptions?: { allowTimeout?: boolean },
  ): Request => {
    if (!joinOptions?.allowTimeout && raw.timeoutMs !== undefined) {
      return invalidRequest("timeoutMs is supported only by testSpeech or testListen");
    }
    try {
      return {
        url: options.normalizeUrl(requireString(raw.url, "url")),
        transport: normalizeTransport(raw.transport),
        mode: normalizeMode(raw.mode),
        message: normalizeOptionalString(raw.message),
        requesterSessionKey: normalizeOptionalString(raw.requesterSessionKey),
        agentId: normalizeOptionalString(raw.agentId),
        timeoutMs: readPositiveIntegerParam(raw, "timeoutMs"),
      } as Request;
    } catch (error) {
      if (options.isInvalidRequest(error)) {
        throw error;
      }
      return invalidRequest(formatErrorMessage(error));
    }
  };
  const gatewayMethod = (action: MeetingToolAction) => `${options.gatewayMethodPrefix}.${action}`;
  const callGatewayFromTool = async (params: {
    action: MeetingToolAction;
    config: Config;
    raw: Record<string, unknown>;
    runtime?: OpenClawPluginApi["runtime"];
  }) => {
    try {
      const timeoutMs = options.resolveGatewayTimeoutMs(params.config);
      if (params.runtime) {
        return await params.runtime.gateway.request(gatewayMethod(params.action), params.raw, {
          timeoutMs,
          scopes: ["operator.admin"],
        });
      }
      return await callGatewayFromCli(
        gatewayMethod(params.action),
        { json: true, timeout: String(timeoutMs) },
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
  };

  return {
    id: options.id,
    name: options.name,
    description: options.description,
    configSchema: options.configSchema,
    register(api: OpenClawPluginApi) {
      const config = options.configSchema.parse(api.pluginConfig) as Config;
      let runtime: Runtime | undefined;
      const ensureRuntime = async () => {
        if (!config.enabled) {
          throw new Error(options.disabledMessage);
        }
        runtime ??= options.createRuntime({ api, config });
        return runtime;
      };
      if (options.transcriptSource) {
        api.registerTranscriptSourceProvider(
          createMeetingTranscriptSourceProvider({
            ...options.transcriptSource,
            runtime: async () => {
              const resolved = await ensureRuntime();
              if (!resolved.startTranscriptSource || !resolved.stopTranscriptSource) {
                throw new Error(`${options.name} transcript source runtime is unavailable`);
              }
              return resolved as MeetingTranscriptSourceRuntime;
            },
          }),
        );
      }
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
          options.isInvalidRequest(error) ? ErrorCodes.INVALID_REQUEST : ErrorCodes.UNAVAILABLE,
        );

      api.registerGatewayMethod(
        `${options.gatewayMethodPrefix}.join`,
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
        `${options.gatewayMethodPrefix}.leave`,
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
        `${options.gatewayMethodPrefix}.status`,
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
        `${options.gatewayMethodPrefix}.transcript`,
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
        `${options.gatewayMethodPrefix}.speak`,
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
        `${options.gatewayMethodPrefix}.setup`,
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
          `${options.gatewayMethodPrefix}.testSpeech`,
          (rt: Runtime, raw: Record<string, unknown>) =>
            rt.testSpeech(joinRequest(raw, { allowTimeout: true })),
        ],
        [
          `${options.gatewayMethodPrefix}.testListen`,
          (rt: Runtime, raw: Record<string, unknown>) =>
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
          name: options.toolName,
          label: options.toolLabel,
          description: options.toolDescription,
          parameters: options.toolParameters,
          async execute(_toolCallId, params) {
            const raw = asRecord(params);
            const action = raw.action as MeetingToolAction;
            const requesterSessionKey = normalizeOptionalString(toolContext.sessionKey);
            const contextAgentId =
              toolContext.agentId ?? parseAgentSessionKey(requesterSessionKey)?.agentId;
            const agentId = options.normalizeToolAgentId(contextAgentId);
            try {
              if (!(["join", "leave", "status", "transcript", "speak"] as const).includes(action)) {
                throw new Error(options.unknownActionMessage);
              }
              const runtimeForTool = await options.resolveToolRuntime(api, agentId);
              return jsonResult(
                await callGatewayFromTool({
                  action,
                  config,
                  raw: {
                    ...raw,
                    ...(requesterSessionKey ? { requesterSessionKey } : {}),
                    ...(runtimeForTool && agentId ? { agentId } : {}),
                  },
                  runtime: runtimeForTool,
                }),
              );
            } catch (error) {
              return jsonResult({ error: formatErrorMessage(error) });
            }
          },
        }),
        { name: options.toolName },
      );
      if (options.registerNodeWhen(config)) {
        api.registerNodeHostCommand({
          command: options.nodeCommand,
          cap: options.cap,
          dangerous: true,
          handle: (paramsJSON) => options.nodeHandler(paramsJSON),
        });
        api.registerNodeInvokePolicy(options.createNodePolicy(config));
      }
      options.registerCli(api, config);
    },
  };
}
