import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "../../shared/string-coerce.js";
import {
  REALTIME_VOICE_AGENT_CONSULT_TOOL,
  REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
} from "../../talk/agent-consult-tool.js";
import { resolveConfiguredRealtimeVoiceProvider } from "../../talk/provider-resolver.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateTalkClientCreateParams,
  validateTalkClientToolCallParams,
} from "../protocol/index.js";
import { startTalkRealtimeAgentConsult } from "../talk-agent-consult.js";
import { formatForLog } from "../ws-log.js";
import {
  buildRealtimeInstructions,
  buildRealtimeVoiceLaunchOptions,
  buildTalkRealtimeConfig,
  isUnsupportedBrowserWebRtcSession,
} from "./talk-shared.js";
import type { GatewayRequestHandlers } from "./types.js";

export const talkClientHandlers: GatewayRequestHandlers = {
  "talk.client.create": async ({ params, respond, context }) => {
    if (!validateTalkClientCreateParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid talk.client.create params: ${formatValidationErrors(validateTalkClientCreateParams.errors)}`,
        ),
      );
      return;
    }
    const typedParams = params as {
      provider?: string;
      model?: string;
      voice?: string;
      vadThreshold?: number;
      silenceDurationMs?: number;
      prefixPaddingMs?: number;
      reasoningEffort?: string;
      mode?: string;
      transport?: string;
      brain?: string;
    };
    try {
      const runtimeConfig = context.getRuntimeConfig();
      const realtimeConfig = buildTalkRealtimeConfig(runtimeConfig, typedParams.provider);
      const mode =
        normalizeOptionalLowercaseString(typedParams.mode) ?? realtimeConfig.mode ?? "realtime";
      if (mode !== "realtime") {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `talk.client.create only supports mode="realtime"; use talk.catalog for ${mode} provider discovery`,
          ),
        );
        return;
      }
      const brain =
        normalizeOptionalLowercaseString(typedParams.brain) ??
        realtimeConfig.brain ??
        "agent-consult";
      if (brain !== "agent-consult") {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `talk.client.create only supports brain="agent-consult"`,
          ),
        );
        return;
      }
      const transport =
        normalizeOptionalLowercaseString(typedParams.transport) ?? realtimeConfig.transport;
      if (transport === "managed-room") {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.UNAVAILABLE,
            "managed-room realtime Talk sessions are not available in the browser UI yet",
          ),
        );
        return;
      }
      if (transport === "gateway-relay") {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `talk.client.create is client-owned; use talk.session.create for gateway-relay`,
          ),
        );
        return;
      }
      const resolution = resolveConfiguredRealtimeVoiceProvider({
        configuredProviderId: realtimeConfig.provider,
        providerConfigs: realtimeConfig.providers,
        cfg: runtimeConfig,
        cfgForResolve: runtimeConfig,
        noRegisteredProviderMessage: "No realtime voice provider registered",
      });
      const launchOptions = buildRealtimeVoiceLaunchOptions({
        requested: typedParams,
        defaults: realtimeConfig,
      });
      if (resolution.provider.createBrowserSession && transport !== "gateway-relay") {
        const session = await resolution.provider.createBrowserSession({
          cfg: runtimeConfig,
          providerConfig: resolution.providerConfig,
          instructions: buildRealtimeInstructions(realtimeConfig.instructions),
          tools: [REALTIME_VOICE_AGENT_CONSULT_TOOL],
          ...launchOptions,
        });
        if (
          !isUnsupportedBrowserWebRtcSession(session) &&
          (!transport || session.transport === transport)
        ) {
          respond(true, session, undefined);
          return;
        }
        if (transport) {
          respond(
            false,
            undefined,
            errorShape(
              ErrorCodes.UNAVAILABLE,
              `Realtime provider "${resolution.provider.id}" does not support requested browser transport "${transport}"`,
            ),
          );
          return;
        }
      }
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.UNAVAILABLE,
          `Realtime provider "${resolution.provider.id}" does not support client-owned realtime sessions`,
        ),
      );
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
    }
  },
  "talk.client.toolCall": async (request) => {
    const { params, respond } = request;
    if (!validateTalkClientToolCallParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid talk.client.toolCall params: ${formatValidationErrors(validateTalkClientToolCallParams.errors)}`,
        ),
      );
      return;
    }
    if (params.name !== REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `unsupported realtime Talk tool: ${params.name}`),
      );
      return;
    }

    const result = await startTalkRealtimeAgentConsult({
      context: request.context,
      client: request.client,
      isWebchatConnect: request.isWebchatConnect,
      requestId: request.req.id,
      sessionKey: params.sessionKey,
      callId: params.callId,
      args: params.args ?? {},
      relaySessionId: normalizeOptionalString(params.relaySessionId),
      connId: normalizeOptionalString(request.client?.connId),
    });
    if (!result.ok) {
      respond(false, undefined, result.error);
      return;
    }
    respond(
      true,
      {
        runId: result.runId,
        idempotencyKey: result.idempotencyKey,
      },
      undefined,
    );
  },
};
