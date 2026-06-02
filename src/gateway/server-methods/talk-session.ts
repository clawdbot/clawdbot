import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  validateTalkSessionAppendAudioParams,
  validateTalkSessionCancelOutputParams,
  validateTalkSessionCancelTurnParams,
  validateTalkSessionCloseParams,
  validateTalkSessionCreateParams,
  validateTalkSessionJoinParams,
  validateTalkSessionSteerParams,
  validateTalkSessionSubmitToolResultParams,
  validateTalkSessionTurnParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { REALTIME_VOICE_AGENT_CONSULT_TOOL } from "../../talk/agent-consult-tool.js";
import { REALTIME_VOICE_AGENT_CONTROL_TOOL } from "../../talk/agent-run-control-shared.js";
import { controlRealtimeVoiceAgentRun } from "../../talk/agent-run-control.js";
import { resolveConfiguredRealtimeVoiceProvider } from "../../talk/provider-resolver.js";
import type { TalkBrain, TalkMode, TalkTransport } from "../../talk/talk-events.js";
import { ADMIN_SCOPE } from "../operator-scopes.js";
import { resolveSessionKeyFromResolveParams } from "../sessions-resolve.js";
import {
  cancelTalkHandoffTurn,
  createTalkHandoff,
  endTalkHandoffTurn,
  getTalkHandoff,
  joinTalkHandoff,
  revokeTalkHandoff,
  startTalkHandoffTurn,
  type TalkHandoffTurnResult,
} from "../talk-handoff.js";
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
  type UnifiedTalkSessionRecord,
} from "../talk-session-registry.js";
import {
  cancelTalkTranscriptionRelayTurn,
  createTalkTranscriptionRelaySession,
  sendTalkTranscriptionRelayAudio,
  stopTalkTranscriptionRelaySession,
} from "../talk-transcription-relay.js";
import { formatForLog } from "../ws-log.js";
import {
  broadcastTalkRoomEvents,
  buildRealtimeInstructions,
  buildRealtimeVoiceLaunchOptions,
  buildTalkRealtimeConfig,
  buildTalkTranscriptionConfig,
  canUseTalkDirectTools,
  resolveConfiguredRealtimeTranscriptionProvider,
  talkHandoffErrorCode,
  withRealtimeBrowserOverrides,
} from "./talk-shared.js";
import type { GatewayRequestContext, GatewayRequestHandlers, RespondFn } from "./types.js";
import { assertValidParams } from "./validation.js";

type ManagedRoomTalkSession = Extract<UnifiedTalkSessionRecord, { kind: "managed-room" }>;

function normalizeTalkSessionMode(params: { mode?: string; transport?: string }): TalkMode {
  const mode = normalizeOptionalLowercaseString(params.mode) as TalkMode | undefined;
  if (mode) {
    return mode;
  }
  return normalizeOptionalLowercaseString(params.transport) === "managed-room"
    ? "stt-tts"
    : "realtime";
}

function normalizeTalkSessionTransport(params: {
  mode: TalkMode;
  transport?: string;
}): TalkTransport {
  const transport = normalizeOptionalLowercaseString(params.transport) as TalkTransport | undefined;
  if (transport) {
    return transport;
  }
  return params.mode === "stt-tts" ? "managed-room" : "gateway-relay";
}

function normalizeTalkSessionBrain(params: { mode: TalkMode; brain?: string }): TalkBrain {
  const brain = normalizeOptionalLowercaseString(params.brain) as TalkBrain | undefined;
  if (brain) {
    return brain;
  }
  return params.mode === "transcription" ? "none" : "agent-consult";
}

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
  respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
}

function respondOk(respond: RespondFn, payload: unknown = { ok: true }) {
  respond(true, payload, undefined);
}

function respondManagedRoomTurn(params: {
  session: UnifiedTalkSessionRecord;
  connId?: string;
  context: GatewayRequestContext;
  respond: RespondFn;
  method: "talk.session.startTurn" | "talk.session.endTurn" | "talk.session.cancelTurn";
  ownershipAction: "startTurn" | "endTurn" | "cancelTurn";
  failureVerb: "start" | "end" | "cancel";
  run: (session: ManagedRoomTalkSession) => TalkHandoffTurnResult;
}) {
  if (params.session.kind !== "managed-room") {
    respondInvalidRequest(params.respond, `${params.method} requires managed-room`);
    return;
  }
  if (!isActiveManagedRoomClient(params.session, params.connId)) {
    params.respond(false, undefined, managedRoomOwnershipError(params.ownershipAction));
    return;
  }
  const result = params.run(params.session);
  if (!result.ok) {
    params.respond(
      false,
      undefined,
      errorShape(
        talkHandoffErrorCode(result.reason),
        `talk turn ${params.failureVerb} failed: ${result.reason}`,
      ),
    );
    return;
  }
  broadcastTalkRoomEvents(params.context, result.record.room.activeClientId, {
    handoffId: result.record.id,
    roomId: result.record.roomId,
    events: result.events,
  });
  respondOk(params.respond, { ok: true, turnId: result.turnId, events: result.events });
}

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
        respondOk(respond, {
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
        return;
      }

      const connId = client?.connId;
      if (!connId) {
        respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, "Talk session unavailable"));
        return;
      }

      if (mode === "realtime") {
        if (transport !== "gateway-relay" || brain !== "agent-consult") {
          respondInvalidRequest(
            respond,
            `realtime talk.session.create requires transport="gateway-relay" and brain="agent-consult"`,
          );
          return;
        }
        const runtimeConfig = context.getRuntimeConfig();
        const realtimeConfig = buildTalkRealtimeConfig(runtimeConfig, params.provider);
        const resolution = resolveConfiguredRealtimeVoiceProvider({
          configuredProviderId: realtimeConfig.provider,
          providerConfigs: realtimeConfig.providers,
          cfg: runtimeConfig,
          cfgForResolve: runtimeConfig,
          defaultModel: realtimeConfig.model,
          noRegisteredProviderMessage: "No realtime voice provider registered",
        });
        const launchOptions = buildRealtimeVoiceLaunchOptions({
          requested: params,
          defaults: realtimeConfig,
        });
        const session = createTalkRealtimeRelaySession({
          context,
          connId,
          cfg: runtimeConfig,
          provider: resolution.provider,
          providerConfig: withRealtimeBrowserOverrides(resolution.providerConfig, launchOptions),
          instructions: buildRealtimeInstructions(realtimeConfig.instructions),
          tools: [REALTIME_VOICE_AGENT_CONSULT_TOOL, REALTIME_VOICE_AGENT_CONTROL_TOOL],
          model: launchOptions.model,
          sessionKey: normalizeOptionalString(params.sessionKey),
          voice: launchOptions.voice,
          forceAgentConsultOnFinalTranscript:
            realtimeConfig.consultRouting === "force-agent-consult",
        });
        rememberUnifiedTalkSession(session.relaySessionId, {
          kind: "realtime-relay",
          connId,
          relaySessionId: session.relaySessionId,
        });
        respondOk(respond, {
          ...session,
          sessionId: session.relaySessionId,
          mode,
          brain,
        });
        return;
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
  "talk.session.join": async ({ params, respond, client, context }) => {
    if (!assertValidParams(params, validateTalkSessionJoinParams, "talk.session.join", respond)) {
      return;
    }
    try {
      const session = getUnifiedTalkSession(params.sessionId);
      if (session.kind !== "managed-room") {
        respondInvalidRequest(respond, "talk.session.join requires a managed-room session");
        return;
      }
      const result = joinTalkHandoff(session.handoffId, params.token, { clientId: client?.connId });
      if (!result.ok) {
        respond(
          false,
          undefined,
          errorShape(
            result.reason === "invalid_token" ? ErrorCodes.INVALID_REQUEST : ErrorCodes.UNAVAILABLE,
            `talk session join failed: ${result.reason}`,
          ),
        );
        return;
      }
      broadcastTalkRoomEvents(context, result.replacedClientId, {
        handoffId: result.record.id,
        roomId: result.record.roomId,
        events: result.replacementEvents,
      });
      broadcastTalkRoomEvents(context, client?.connId, {
        handoffId: result.record.id,
        roomId: result.record.roomId,
        events: result.activeClientEvents,
      });
      respondOk(respond, result.record);
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
  "talk.session.startTurn": async ({ params, respond, client, context }) => {
    if (
      !assertValidParams(params, validateTalkSessionTurnParams, "talk.session.startTurn", respond)
    ) {
      return;
    }
    try {
      const session = getUnifiedTalkSession(params.sessionId);
      respondManagedRoomTurn({
        session,
        connId: client?.connId,
        context,
        respond,
        method: "talk.session.startTurn",
        ownershipAction: "startTurn",
        failureVerb: "start",
        run: (managedSession) =>
          startTalkHandoffTurn(managedSession.handoffId, managedSession.token, {
            turnId: params.turnId,
            clientId: client?.connId,
          }),
      });
    } catch (err) {
      respondUnavailable(respond, err);
    }
  },
  "talk.session.endTurn": async ({ params, respond, client, context }) => {
    if (
      !assertValidParams(params, validateTalkSessionTurnParams, "talk.session.endTurn", respond)
    ) {
      return;
    }
    try {
      const session = getUnifiedTalkSession(params.sessionId);
      respondManagedRoomTurn({
        session,
        connId: client?.connId,
        context,
        respond,
        method: "talk.session.endTurn",
        ownershipAction: "endTurn",
        failureVerb: "end",
        run: (managedSession) =>
          endTalkHandoffTurn(managedSession.handoffId, managedSession.token, {
            turnId: params.turnId,
          }),
      });
    } catch (err) {
      respondUnavailable(respond, err);
    }
  },
  "talk.session.cancelTurn": async ({ params, respond, client, context }) => {
    if (
      !assertValidParams(
        params,
        validateTalkSessionCancelTurnParams,
        "talk.session.cancelTurn",
        respond,
      )
    ) {
      return;
    }
    try {
      const session = getUnifiedTalkSession(params.sessionId);
      if (session.kind === "realtime-relay") {
        const connId = requireUnifiedTalkSessionConn(session, client?.connId);
        cancelTalkRealtimeRelayTurn({
          relaySessionId: session.relaySessionId,
          connId,
          reason: normalizeOptionalString(params.reason),
        });
        respondOk(respond);
        return;
      }
      if (session.kind === "transcription-relay") {
        const connId = requireUnifiedTalkSessionConn(session, client?.connId);
        cancelTalkTranscriptionRelayTurn({
          transcriptionSessionId: session.transcriptionSessionId,
          connId,
          reason: normalizeOptionalString(params.reason),
        });
        respondOk(respond);
        return;
      }
      respondManagedRoomTurn({
        session,
        connId: client?.connId,
        context,
        respond,
        method: "talk.session.cancelTurn",
        ownershipAction: "cancelTurn",
        failureVerb: "cancel",
        run: (managedSession) =>
          cancelTalkHandoffTurn(managedSession.handoffId, managedSession.token, {
            turnId: params.turnId,
            reason: params.reason,
          }),
      });
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
      submitTalkRealtimeRelayToolResult({
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
