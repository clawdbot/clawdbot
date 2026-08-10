import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  validateTalkSessionAppendAudioParams,
  validateTalkSessionCancelOutputParams,
  validateTalkSessionCloseParams,
  validateTalkSessionCreateParams,
  validateTalkSessionSteerParams,
  validateTalkSessionSubmitToolResultParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { buildAgentMainSessionKey } from "../../routing/session-key.js";
import { REALTIME_VOICE_AGENT_CONSULT_TOOL } from "../../talk/agent-consult-tool.js";
import { REALTIME_VOICE_AGENT_CONTROL_TOOL } from "../../talk/agent-run-control-shared.js";
import { controlRealtimeVoiceAgentRun } from "../../talk/agent-run-control.js";
import { resolveTalkSessionAgentId } from "../../talk/agent-target.js";
import { ensureClientVoiceAgentSessionEntry } from "../../talk/client-voice-session.js";
import { resolveConfiguredRealtimeVoiceProvider } from "../../talk/provider-resolver.js";
import { ADMIN_SCOPE } from "../operator-scopes.js";
import { resolveSessionKeyFromResolveParams } from "../sessions-resolve.js";
import { createTalkHandoff, getTalkHandoff, revokeTalkHandoff } from "../talk-handoff.js";
import {
  cancelTalkRealtimeRelayTurn,
  createTalkRealtimeRelaySession,
  sendTalkRealtimeRelayAudio,
  steerTalkRealtimeRelayAgentRun,
  stopTalkRealtimeRelaySession,
  submitTalkRealtimeRelayToolResult,
} from "../talk-realtime-relay.js";
import {
  forgetUnifiedTalkSession,
  getUnifiedTalkSession,
  rememberUnifiedTalkSession,
  requireUnifiedTalkSessionConn,
} from "../talk-session-registry.js";
import {
  createTalkTranscriptionRelaySession,
  sendTalkTranscriptionRelayAudio,
  stopTalkTranscriptionRelaySession,
} from "../talk-transcription-relay.js";
import { formatForLog } from "../ws-log.js";
import { acknowledgeTalkSessionMark } from "./talk-session-mark.js";
import {
  broadcastTalkRoomEvents,
  buildRealtimeInstructions,
  buildRealtimeVoiceLaunchOptions,
  buildTalkRealtimeConfig,
  buildTalkTranscriptionConfig,
  canUseTalkDirectTools,
  normalizeTalkSessionBrain,
  normalizeTalkSessionMode,
  normalizeTalkSessionTransport,
  resolveConfiguredRealtimeTranscriptionProvider,
  resolveTalkRealtimeProviderInstructions,
  resolveTalkRealtimeGatewayRelayLaunch,
} from "./talk-shared.js";
import type { GatewayRequestHandlers, RespondFn } from "./types.js";
import { assertValidParams } from "./validation.js";

function isActiveManagedRoomClient(
  session: { handoffId: string },
  connId: string | undefined,
): boolean {
  if (!connId) {
    return false;
  }
  const handoff = getTalkHandoff(session.handoffId);
  return handoff?.room.activeClientId === connId;
}

function canCloseManagedRoomSession(
  session: { handoffId: string },
  connId: string | undefined,
): boolean {
  const handoff = getTalkHandoff(session.handoffId);
  return !handoff?.room.activeClientId || handoff.room.activeClientId === connId;
}

function canCreateUnscopedManagedRoomSession(
  client: { connect?: { scopes?: string[] } } | null,
): boolean {
  return client?.connect?.scopes?.includes(ADMIN_SCOPE) === true;
}

function managedRoomOwnershipError(action: string) {
  return errorShape(
    ErrorCodes.INVALID_REQUEST,
    `talk.session.${action} requires the active managed-room connection`,
  );
}

function respondInvalidRequest(respond: RespondFn, message: string) {
  respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, message));
}

function respondUnavailable(respond: RespondFn, err: unknown) {
  const message = formatForLog(err);
  respond(
    false,
    undefined,
    errorShape(ErrorCodes.UNAVAILABLE, message, {
      details: {
        talkIssue: {
          code: "realtime_unavailable",
          message,
          phase: "request",
        },
      },
    }),
  );
}

function respondOk(respond: RespondFn, payload: unknown = { ok: true }) {
  respond(true, payload, undefined);
}

/** RPC handlers for gateway-managed Talk sessions and room lifecycle. */
export const talkSessionHandlers: GatewayRequestHandlers = {
  "talk.session.create": async ({ params, respond, context, client }) => {
    if (
      !assertValidParams(params, validateTalkSessionCreateParams, "talk.session.create", respond)
    ) {
      return;
    }

    const mode = normalizeTalkSessionMode(params);
    const transport = normalizeTalkSessionTransport({ mode, transport: params.transport });
    const brain = normalizeTalkSessionBrain({ mode, brain: params.brain });

    if (transport === "webrtc" || transport === "provider-websocket") {
      respondInvalidRequest(
        respond,
        `talk.session.create is Gateway-managed; use talk.client.create for client transport "${transport}"`,
      );
      return;
    }
    try {
      if (transport === "managed-room") {
        if (brain === "direct-tools" && !canUseTalkDirectTools(client)) {
          respondInvalidRequest(
            respond,
            `talk.session.create brain="direct-tools" requires gateway scope: ${ADMIN_SCOPE}`,
          );
          return;
        }
        const spawnedBy = normalizeOptionalString(params.spawnedBy);
        if (
          normalizeOptionalString(params.sessionKey) &&
          !spawnedBy &&
          !canCreateUnscopedManagedRoomSession(client)
        ) {
          respondInvalidRequest(
            respond,
            `talk.session.create managed-room sessionKey requires spawnedBy or gateway scope: ${ADMIN_SCOPE}`,
          );
          return;
        }
        const resolvedSession = await resolveSessionKeyFromResolveParams({
          cfg: context.getRuntimeConfig(),
          client,
          p: {
            key: params.sessionKey,
            ...(spawnedBy ? { spawnedBy } : {}),
            includeGlobal: true,
            includeUnknown: true,
          },
        });
        if (!resolvedSession.ok) {
          respond(false, undefined, resolvedSession.error);
          return;
        }
        if ("missing" in resolvedSession || "ambiguous" in resolvedSession) {
          respondInvalidRequest(respond, `No session found: ${params.sessionKey}`);
          return;
        }
        const handoff = createTalkHandoff({
          sessionKey: resolvedSession.key,
          provider: normalizeOptionalString(params.provider),
          model: normalizeOptionalString(params.model),
          voice: normalizeOptionalString(params.voice),
          mode,
          transport,
          brain,
          ttlMs: params.ttlMs,
        });
        rememberUnifiedTalkSession(handoff.id, {
          kind: "managed-room",
          handoffId: handoff.id,
          token: handoff.token,
          roomId: handoff.roomId,
        });
        return respondOk(respond, {
          sessionId: handoff.id,
          provider: handoff.provider,
          mode: handoff.mode,
          transport: handoff.transport,
          brain: handoff.brain,
          handoffId: handoff.id,
          roomId: handoff.roomId,
          roomUrl: handoff.roomUrl,
          token: handoff.token,
          model: handoff.model,
          voice: handoff.voice,
          expiresAt: handoff.expiresAt,
        });
      }

      const connId = client?.connId;
      if (!connId) {
        respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, "Talk session unavailable"));
        return;
      }

      if (mode === "realtime") {
        if (transport !== "gateway-relay" || brain !== "agent-consult") {
          return respondInvalidRequest(
            respond,
            `realtime talk.session.create requires transport="gateway-relay" and brain="agent-consult"`,
          );
        }
        const runtimeConfig = context.getRuntimeConfig();
        const realtimeConfig = buildTalkRealtimeConfig(runtimeConfig, params.provider);
        const launchOptions = buildRealtimeVoiceLaunchOptions({
          requested: params,
          defaults: realtimeConfig,
        });
        const agentId = resolveTalkSessionAgentId(runtimeConfig, params.sessionKey);
        const resolution = resolveConfiguredRealtimeVoiceProvider({
          configuredProviderId: realtimeConfig.provider,
          providerConfigs: realtimeConfig.providers,
          providerConfigOverrides: launchOptions.model ? { model: launchOptions.model } : {},
          cfg: runtimeConfig,
          agentId,
          defaultModel: realtimeConfig.model,
          surface: "gateway-relay",
        });
        const relayLaunch = resolveTalkRealtimeGatewayRelayLaunch({
          ...resolution,
          cfg: runtimeConfig,
          launchOptions,
          consultRouting: realtimeConfig.consultRouting,
        });
        if (relayLaunch.error) {
          // GPT-Live delegates natively; forced transcript consults are a GA-model mode.
          return respondInvalidRequest(respond, relayLaunch.error);
        }
        const realtimeContext = await resolveTalkRealtimeProviderInstructions({
          config: runtimeConfig,
          agentId,
          configuredInstructions: realtimeConfig.instructions,
          sessionKey: params.sessionKey,
          requireSessionKeyForProfile: true,
          warn: (message) => context.logGateway.warn(`talk realtime context: ${message}`),
        });
        const sessionKey =
          realtimeContext.requestedSessionKey ??
          buildAgentMainSessionKey({ agentId: realtimeContext.agentId });
        await ensureClientVoiceAgentSessionEntry({
          agentId: realtimeContext.agentId,
          sessionKey,
        });
        const session = createTalkRealtimeRelaySession({
          context,
          connId,
          cfg: runtimeConfig,
          provider: resolution.provider,
          providerConfig: relayLaunch.providerConfig,
          instructions: buildRealtimeInstructions(realtimeContext.instructions),
          tools: [REALTIME_VOICE_AGENT_CONSULT_TOOL, REALTIME_VOICE_AGENT_CONTROL_TOOL],
          model: launchOptions.model,
          sessionKey,
          voice: launchOptions.voice,
          language: normalizeOptionalLowercaseString(params.language),
          forceAgentConsultOnFinalTranscript: relayLaunch.forceAgentConsultOnFinalTranscript,
        });
        rememberUnifiedTalkSession(session.relaySessionId, {
          kind: "realtime-relay",
          connId,
          relaySessionId: session.relaySessionId,
        });
        return respondOk(respond, {
          ...session,
          sessionId: session.relaySessionId,
          voiceSessionId: session.relaySessionId,
          mode,
          brain,
        });
      }

      if (mode === "transcription") {
        if (transport !== "gateway-relay" || brain !== "none") {
          respondInvalidRequest(
            respond,
            `transcription talk.session.create requires transport="gateway-relay" and brain="none"`,
          );
          return;
        }
        const runtimeConfig = context.getRuntimeConfig();
        const transcriptionConfig = buildTalkTranscriptionConfig(runtimeConfig, params.provider);
        const resolution = resolveConfiguredRealtimeTranscriptionProvider({
          config: runtimeConfig,
          configuredProviderId: transcriptionConfig.provider,
          providerConfigs: transcriptionConfig.providers,
          defaultModel: transcriptionConfig.model,
        });
        const session = createTalkTranscriptionRelaySession({
          context,
          connId,
          provider: resolution.provider,
          providerConfig: resolution.providerConfig,
        });
        rememberUnifiedTalkSession(session.transcriptionSessionId, {
          kind: "transcription-relay",
          connId,
          transcriptionSessionId: session.transcriptionSessionId,
        });
        respondOk(respond, {
          ...session,
          sessionId: session.transcriptionSessionId,
          brain,
        });
        return;
      }

      respondInvalidRequest(
        respond,
        `stt-tts talk.session.create requires transport="managed-room"`,
      );
    } catch (err) {
      respondUnavailable(respond, err);
    }
  },
  "talk.session.appendAudio": async ({ params, respond, client }) => {
    if (
      !assertValidParams(
        params,
        validateTalkSessionAppendAudioParams,
        "talk.session.appendAudio",
        respond,
      )
    ) {
      return;
    }
    try {
      const session = getUnifiedTalkSession(params.sessionId);
      if (session.kind === "realtime-relay") {
        const connId = requireUnifiedTalkSessionConn(session, client?.connId);
        sendTalkRealtimeRelayAudio({
          relaySessionId: session.relaySessionId,
          connId,
          audioBase64: params.audioBase64,
          timestamp: params.timestamp,
        });
        respondOk(respond);
        return;
      }
      if (session.kind === "transcription-relay") {
        const connId = requireUnifiedTalkSessionConn(session, client?.connId);
        sendTalkTranscriptionRelayAudio({
          transcriptionSessionId: session.transcriptionSessionId,
          connId,
          audioBase64: params.audioBase64,
        });
        respondOk(respond);
        return;
      }
      respondInvalidRequest(
        respond,
        "talk.session.appendAudio is not supported for managed-room sessions",
      );
    } catch (err) {
      respondUnavailable(respond, err);
    }
  },
  "talk.session.cancelOutput": async ({ params, respond, client }) => {
    if (
      !assertValidParams(
        params,
        validateTalkSessionCancelOutputParams,
        "talk.session.cancelOutput",
        respond,
      )
    ) {
      return;
    }
    try {
      const session = getUnifiedTalkSession(params.sessionId);
      if (session.kind !== "realtime-relay") {
        respondInvalidRequest(respond, "talk.session.cancelOutput requires realtime relay");
        return;
      }
      const connId = requireUnifiedTalkSessionConn(session, client?.connId);
      cancelTalkRealtimeRelayTurn({
        relaySessionId: session.relaySessionId,
        connId,
        reason: normalizeOptionalString(params.reason) ?? "output-cancelled",
      });
      respondOk(respond);
    } catch (err) {
      respondUnavailable(respond, err);
    }
  },
  "talk.session.acknowledgeMark": acknowledgeTalkSessionMark,
  "talk.session.submitToolResult": async ({ params, respond, client }) => {
    if (
      !assertValidParams(
        params,
        validateTalkSessionSubmitToolResultParams,
        "talk.session.submitToolResult",
        respond,
      )
    ) {
      return;
    }
    try {
      const session = getUnifiedTalkSession(params.sessionId);
      if (session.kind !== "realtime-relay") {
        respondInvalidRequest(
          respond,
          "talk.session.submitToolResult is only supported for realtime relay sessions",
        );
        return;
      }
      const connId = requireUnifiedTalkSessionConn(session, client?.connId);
      await submitTalkRealtimeRelayToolResult({
        relaySessionId: session.relaySessionId,
        connId,
        callId: params.callId,
        result: params.result,
        options: params.options,
      });
      respondOk(respond);
    } catch (err) {
      respondUnavailable(respond, err);
    }
  },
  "talk.session.steer": async ({ params, respond, client }) => {
    if (!assertValidParams(params, validateTalkSessionSteerParams, "talk.session.steer", respond)) {
      return;
    }
    try {
      const session = getUnifiedTalkSession(params.sessionId);
      if (session.kind === "realtime-relay") {
        const connId = requireUnifiedTalkSessionConn(session, client?.connId);
        const result = await steerTalkRealtimeRelayAgentRun({
          relaySessionId: session.relaySessionId,
          connId,
          sessionKey: normalizeOptionalString(params.sessionKey),
          text: params.text,
          mode: normalizeOptionalString(params.mode),
        });
        respondOk(respond, result);
        return;
      }
      if (session.kind === "transcription-relay") {
        respondInvalidRequest(respond, "talk.session.steer requires an agent-backed Talk session");
        return;
      }
      if (!isActiveManagedRoomClient(session, client?.connId)) {
        respond(false, undefined, managedRoomOwnershipError("steer"));
        return;
      }
      const handoff = getTalkHandoff(session.handoffId);
      const sessionKey = handoff?.sessionKey;
      if (!sessionKey) {
        respondInvalidRequest(respond, "talk.session.steer requires a session key");
        return;
      }
      const requestedSessionKey = normalizeOptionalString(params.sessionKey);
      if (requestedSessionKey && requestedSessionKey !== sessionKey) {
        respondInvalidRequest(
          respond,
          "talk.session.steer sessionKey does not match the managed-room session",
        );
        return;
      }
      const result = await controlRealtimeVoiceAgentRun({
        sessionKey,
        text: params.text,
        mode: params.mode,
        recentEvents: handoff?.room.talk.recentEvents,
      });
      respondOk(respond, result);
    } catch (err) {
      respondUnavailable(respond, err);
    }
  },
  "talk.session.close": async ({ params, respond, client, context }) => {
    if (!assertValidParams(params, validateTalkSessionCloseParams, "talk.session.close", respond)) {
      return;
    }
    try {
      const session = getUnifiedTalkSession(params.sessionId);
      if (session.kind === "realtime-relay") {
        const connId = requireUnifiedTalkSessionConn(session, client?.connId);
        stopTalkRealtimeRelaySession({ relaySessionId: session.relaySessionId, connId });
      } else if (session.kind === "transcription-relay") {
        const connId = requireUnifiedTalkSessionConn(session, client?.connId);
        stopTalkTranscriptionRelaySession({
          transcriptionSessionId: session.transcriptionSessionId,
          connId,
        });
      } else {
        if (!canCloseManagedRoomSession(session, client?.connId)) {
          respond(false, undefined, managedRoomOwnershipError("close"));
          return;
        }
        const result = revokeTalkHandoff(session.handoffId);
        broadcastTalkRoomEvents(context, result.activeClientId, {
          handoffId: session.handoffId,
          roomId: session.roomId,
          events: result.events,
        });
      }
      forgetUnifiedTalkSession(params.sessionId);
      respondOk(respond);
    } catch (err) {
      respondUnavailable(respond, err);
    }
  },
};
