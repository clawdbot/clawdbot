// Talk client methods create browser-owned realtime voice sessions and route
// client tool calls back into OpenClaw agent consult/control flows.
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateTalkClientCloseParams,
  validateTalkClientCreateParams,
  validateTalkClientSteerParams,
  validateTalkClientToolCallParams,
  validateTalkClientTranscriptParams,
} from "../../../packages/gateway-protocol/src/index.js";
import {
  buildAgentMainSessionKey,
  resolveAgentIdFromSessionKey,
} from "../../routing/session-key.js";
import {
  REALTIME_VOICE_AGENT_CONSULT_TOOL,
  REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
  parseRealtimeVoiceAgentConsultArgs,
} from "../../talk/agent-consult-tool.js";
import { REALTIME_VOICE_AGENT_CONTROL_TOOL } from "../../talk/agent-run-control-shared.js";
import { controlRealtimeVoiceAgentRun } from "../../talk/agent-run-control.js";
import {
  authorizeClientVoiceConfirmation,
  bindAuthorizedClientVoiceConfirmation,
  type ClientVoiceConfirmationGrant,
} from "../../talk/client-voice-confirmation.js";
import {
  appendClientVoiceTranscript,
  assertClientVoiceSessionOpen,
  closeClientVoiceSession,
  closeStaleClientVoiceSessions,
  createOrResumeClientVoiceSession,
  ensureClientVoiceAgentSessionEntry,
  registerClientVoiceConsultRun,
  resolveClientVoiceSessionOrigin,
  resolveOpenClientVoiceSessionId,
} from "../../talk/client-voice-session.js";
import { REALTIME_VOICE_DESCRIBE_VIEW_TOOL } from "../../talk/describe-view-tool.js";
import { resolveConfiguredRealtimeVoiceProvider } from "../../talk/provider-resolver.js";
import { startTalkRealtimeAgentConsult } from "../talk-agent-consult.js";
import {
  ensureTalkRealtimeRelayVoiceSession,
  flushTalkRealtimeRelayVoiceWrites,
} from "../talk-realtime-relay.js";
import { formatForLog } from "../ws-log.js";
import {
  buildRealtimeInstructions,
  buildRealtimeVoiceLaunchOptions,
  buildTalkRealtimeConfig,
  isUnsupportedBrowserWebRtcSession,
  resolveTalkRealtimeProviderInstructions,
} from "./talk-shared.js";
import type { GatewayRequestHandlers } from "./types.js";

const LEGACY_VOICE_BINDING_TTL_MS = 6 * 60 * 60_000;
const legacyVoiceSessionByClient = new Map<string, { voiceSessionId: string; expiresAt: number }>();

function legacyVoiceBindingKey(connId: string, sessionKey: string): string {
  return `${connId}\0${sessionKey}`;
}

function pruneLegacyVoiceBindings(now = Date.now()): void {
  for (const [key, binding] of legacyVoiceSessionByClient) {
    if (binding.expiresAt <= now) {
      legacyVoiceSessionByClient.delete(key);
    }
  }
}

/**
 * Gateway methods for browser-owned realtime Talk sessions.
 *
 * These handlers create provider browser sessions and bridge client-owned tool
 * calls back into OpenClaw agent consult runs.
 */
export const talkClientHandlers: GatewayRequestHandlers = {
  "talk.client.create": async ({ params, respond, context, client }) => {
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
      sessionKey?: string;
      voiceSessionId?: string;
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
      capabilities?: string[];
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
      const wantsCameraFrames = typedParams.capabilities?.includes("camera-frame") === true;
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
            wantsCameraFrames
              ? "gateway-relay does not support browser video frames"
              : `talk.client.create is client-owned; use talk.session.create for gateway-relay`,
          ),
        );
        return;
      }
      const resolution = resolveConfiguredRealtimeVoiceProvider({
        configuredProviderId: realtimeConfig.provider,
        providerConfigs: realtimeConfig.providers,
        cfg: runtimeConfig,
        cfgForResolve: runtimeConfig,
        defaultModel: realtimeConfig.model,
        noRegisteredProviderMessage: "No realtime voice provider registered",
      });
      if (wantsCameraFrames && resolution.provider.capabilities?.supportsVideoFrames !== true) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `Realtime provider ${resolution.provider.id} does not support browser video frames`,
          ),
        );
        return;
      }
      const launchOptions = buildRealtimeVoiceLaunchOptions({
        requested: typedParams,
        defaults: realtimeConfig,
      });
      const realtimeContext = await resolveTalkRealtimeProviderInstructions({
        config: runtimeConfig,
        configuredInstructions: realtimeConfig.instructions,
        sessionKey: typedParams.sessionKey,
        // Legacy creates can drift to another agent's session at toolCall time, so
        // the default agent's profile must not leak into the provider session.
        requireSessionKeyForProfile: true,
        warn: (message) => context.logGateway.warn(`talk realtime context: ${message}`),
      });
      const { agentId, requestedSessionKey } = realtimeContext;
      const sessionKey = requestedSessionKey ?? buildAgentMainSessionKey({ agentId });
      if (resolution.provider.createBrowserSession && transport !== "gateway-relay") {
        const tools = [REALTIME_VOICE_AGENT_CONSULT_TOOL, REALTIME_VOICE_AGENT_CONTROL_TOOL];
        if (wantsCameraFrames) {
          tools.push(REALTIME_VOICE_DESCRIBE_VIEW_TOOL);
        }
        const session = await resolution.provider.createBrowserSession({
          cfg: runtimeConfig,
          providerConfig: resolution.providerConfig,
          instructions: buildRealtimeInstructions(realtimeContext.instructions),
          tools,
          ...launchOptions,
        });
        // Client-owned voice records are minted only for client-owned transports;
        // relay sessions are created via talk.session.create and keyed by relaySessionId.
        // Widening this guard would hand relay calls a mismatched voiceSessionId.
        if (
          (session.transport === "webrtc" || session.transport === "provider-websocket") &&
          !isUnsupportedBrowserWebRtcSession(session) &&
          (!transport || session.transport === transport)
        ) {
          // Recovering 6h-abandoned calls (and retrying their digests) is not on the
          // start path; running it inline would delay use of time-sensitive provider
          // credentials behind slow channel sends. Fire it off the response path.
          void closeStaleClientVoiceSessions({
            agentId,
            config: runtimeConfig,
            excludeVoiceSessionId: normalizeOptionalString(typedParams.voiceSessionId),
            warn: (message) => context.logGateway.warn(`talk voice session recovery: ${message}`),
          }).catch((error: unknown) =>
            context.logGateway.warn(`talk voice session recovery failed: ${formatForLog(error)}`),
          );
          await ensureClientVoiceAgentSessionEntry({ agentId, sessionKey });
          const voiceSessionId = createOrResumeClientVoiceSession({
            agentId,
            sessionKey,
            provider: resolution.provider.id,
            origin: "client",
            // Deployed clients sent sessionKey before transcripts existed, so capability
            // must be negotiated explicitly; declaring it turns the confirmation gate on.
            transcriptCapable: typedParams.capabilities?.includes("voice-transcript") === true,
            voiceSessionId: normalizeOptionalString(typedParams.voiceSessionId),
          });
          const connId = normalizeOptionalString(client?.connId);
          if (connId) {
            const now = Date.now();
            pruneLegacyVoiceBindings(now);
            legacyVoiceSessionByClient.set(
              legacyVoiceBindingKey(connId, typedParams.sessionKey?.trim() || sessionKey),
              { voiceSessionId, expiresAt: now + LEGACY_VOICE_BINDING_TTL_MS },
            );
          }
          respond(true, { ...session, voiceSessionId }, undefined);
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

    const agentId = resolveAgentIdFromSessionKey(params.sessionKey);
    const relaySessionId = normalizeOptionalString(params.relaySessionId);
    const connId = normalizeOptionalString(request.client?.connId);
    pruneLegacyVoiceBindings();
    const explicitVoiceSessionId = normalizeOptionalString(params.voiceSessionId);
    if (relaySessionId && explicitVoiceSessionId && explicitVoiceSessionId !== relaySessionId) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "relaySessionId and voiceSessionId must match"),
      );
      return;
    }
    let confirmationGrant: ClientVoiceConfirmationGrant | undefined;
    let voiceSessionId: string;
    try {
      // Shipped clients may consult without ever creating a voice session (old app,
      // restarted gateway, ambiguous open records). Implicitly create one instead of
      // erroring so confirmation and mutation evidence stay always-on.
      voiceSessionId =
        explicitVoiceSessionId ??
        relaySessionId ??
        (connId
          ? legacyVoiceSessionByClient.get(legacyVoiceBindingKey(connId, params.sessionKey))
              ?.voiceSessionId
          : undefined) ??
        resolveOpenClientVoiceSessionId({ agentId, sessionKey: params.sessionKey }) ??
        createOrResumeClientVoiceSession({
          agentId,
          sessionKey: params.sessionKey,
          origin: "client",
        });
      // Pin the resolved id to this connection so a legacy client's later consults
      // reuse one record instead of forking a new never-closed session each time.
      if (connId && !relaySessionId) {
        const now = Date.now();
        pruneLegacyVoiceBindings(now);
        legacyVoiceSessionByClient.set(legacyVoiceBindingKey(connId, params.sessionKey), {
          voiceSessionId,
          expiresAt: now + LEGACY_VOICE_BINDING_TTL_MS,
        });
      }
      if (relaySessionId && connId) {
        // Initialize the canonical session row BEFORE binding: the bind drains the
        // relay's buffered finals into transcript appends, which fail without it.
        await ensureClientVoiceAgentSessionEntry({ agentId, sessionKey: params.sessionKey });
        ensureTalkRealtimeRelayVoiceSession({
          relaySessionId,
          connId,
          sessionKey: params.sessionKey,
        });
        await flushTalkRealtimeRelayVoiceWrites({ relaySessionId, connId });
      }
      const parsedArgs = parseRealtimeVoiceAgentConsultArgs(params.args ?? {});
      const origin = assertClientVoiceSessionOpen({
        agentId,
        sessionKey: params.sessionKey,
        voiceSessionId,
      });
      if (origin === "relay" && (!relaySessionId || !connId)) {
        throw new Error(
          "relay-owned voice sessions require relaySessionId and connection ownership",
        );
      }
      if (parsedArgs.confirmationId) {
        confirmationGrant = authorizeClientVoiceConfirmation({
          agentId,
          voiceSessionId,
          confirmationId: parsedArgs.confirmationId,
        });
      }
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, formatForLog(err)));
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
      connId,
      onRunStarted: (runId) => {
        registerClientVoiceConsultRun({
          agentId,
          sessionKey: params.sessionKey,
          voiceSessionId,
          runId,
          config: request.context.getRuntimeConfig(),
        });
        if (confirmationGrant) {
          bindAuthorizedClientVoiceConfirmation({ grant: confirmationGrant, runId });
        }
      },
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
  "talk.client.transcript": async ({ params, respond, context }) => {
    if (!validateTalkClientTranscriptParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid talk.client.transcript params: ${formatValidationErrors(validateTalkClientTranscriptParams.errors)}`,
        ),
      );
      return;
    }
    try {
      await appendClientVoiceTranscript({
        agentId: resolveAgentIdFromSessionKey(params.sessionKey),
        sessionKey: params.sessionKey,
        voiceSessionId: params.voiceSessionId,
        entryId: params.entryId,
        role: params.role,
        text: params.text,
        ...(params.timestamp !== undefined ? { timestamp: params.timestamp } : {}),
        config: context.getRuntimeConfig(),
      });
      respond(true, { ok: true }, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, formatForLog(err)));
    }
  },
  "talk.client.close": async ({ params, respond, context, client }) => {
    if (!validateTalkClientCloseParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid talk.client.close params: ${formatValidationErrors(validateTalkClientCloseParams.errors)}`,
        ),
      );
      return;
    }
    try {
      const agentId = resolveAgentIdFromSessionKey(params.sessionKey);
      const origin = resolveClientVoiceSessionOrigin({
        agentId,
        sessionKey: params.sessionKey,
        voiceSessionId: params.voiceSessionId,
      });
      if (origin === "relay") {
        throw new Error("relay-owned voice sessions close through talk.session.stop");
      }
      await closeClientVoiceSession({
        agentId,
        sessionKey: params.sessionKey,
        voiceSessionId: params.voiceSessionId,
        config: context.getRuntimeConfig(),
      });
      const connId = normalizeOptionalString(client?.connId);
      if (connId) {
        const key = legacyVoiceBindingKey(connId, params.sessionKey);
        if (legacyVoiceSessionByClient.get(key)?.voiceSessionId === params.voiceSessionId) {
          legacyVoiceSessionByClient.delete(key);
        }
      }
      respond(true, { ok: true }, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, formatForLog(err)));
    }
  },
  "talk.client.steer": async ({ params, respond, client, context }) => {
    if (!validateTalkClientSteerParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid talk.client.steer params: ${formatValidationErrors(validateTalkClientSteerParams.errors)}`,
        ),
      );
      return;
    }
    if (
      !hasOwnedActiveTalkClientRun({
        context,
        clientConnId: client?.connId,
        sessionKey: params.sessionKey,
      })
    ) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "talk.client.steer requires an active browser-owned Talk run",
        ),
      );
      return;
    }
    try {
      const result = await controlRealtimeVoiceAgentRun({
        sessionKey: params.sessionKey,
        text: params.text,
        mode: params.mode,
      });
      respond(true, result, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
    }
  },
};

function hasOwnedActiveTalkClientRun(params: {
  context: Parameters<GatewayRequestHandlers[string]>[0]["context"];
  clientConnId?: string;
  sessionKey: string;
}): boolean {
  // Browser steering is only allowed for the connection that owns the live
  // browser session; agent-owned consult runs use the relay steering path.
  const connId = normalizeOptionalString(params.clientConnId);
  const sessionKey = params.sessionKey.trim();
  if (!connId || !sessionKey) {
    return false;
  }
  for (const entry of params.context.chatAbortControllers.values()) {
    if (entry.sessionKey === sessionKey && entry.ownerConnId === connId && entry.kind !== "agent") {
      return true;
    }
  }
  return false;
}
