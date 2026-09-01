// Talk client methods create browser-owned realtime voice sessions and route
// client tool calls back into OpenClaw agent consult/control flows.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  validateTalkClientCloseParams,
  validateTalkClientSteerParams,
  validateTalkClientToolCallParams,
  validateTalkClientTranscriptParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { AgentSelectionRequiredError } from "../../agents/agent-scope.js";
import {
  REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
  parseRealtimeVoiceAgentConsultArgs,
} from "../../talk/agent-consult-tool.js";
import { controlRealtimeVoiceAgentRun } from "../../talk/agent-run-control.js";
import { resolveTalkSessionAgentId } from "../../talk/agent-target.js";
import {
  authorizeClientVoiceConfirmation,
  bindAuthorizedClientVoiceConfirmation,
  type ClientVoiceConfirmationGrant,
} from "../../talk/client-voice-confirmation.js";
import {
  appendClientVoiceTranscript,
  assertClientVoiceSessionOpen,
  closeClientVoiceSession,
  createOrResumeClientVoiceSession,
  ensureClientVoiceAgentSessionEntry,
  registerClientVoiceConsultRun,
  resolveClientVoiceSessionOrigin,
  resolveOpenClientVoiceSessionId,
} from "../../talk/client-voice-session.js";
import {
  authorizeGatewaySessionCreation,
  resolveSandboxedSessionCreation,
} from "../operator-role-policy.js";
import { SessionMutationAuthorizationChangedError } from "../session-mutation-authorization-error.js";
import { startTalkRealtimeAgentConsult } from "../talk-agent-consult.js";
import { closeTalkClientGatewayControlSession } from "../talk-client-gateway-control.js";
import {
  ensureTalkRealtimeRelayVoiceSession,
  flushTalkRealtimeRelayVoiceWrites,
} from "../talk-realtime-relay.js";
import { prepareTalkSessionTarget } from "../talk-session-target.js";
import { formatForLog } from "../ws-log.js";
import { createTalkClient } from "./talk-client-create.js";
import {
  forgetLegacyVoiceBinding,
  readLegacyVoiceBinding,
  rememberLegacyVoiceBinding,
} from "./talk-client-legacy-voice-bindings.js";
import { resolveOwnedActiveTalkRunTarget } from "./talk-client-run-ownership.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

/**
 * Gateway methods for browser-owned realtime Talk sessions.
 *
 * These handlers create provider browser sessions and bridge client-owned tool
 * calls back into OpenClaw agent consult runs.
 */
export const talkClientHandlers: GatewayRequestHandlers = {
  "talk.client.create": createTalkClient,
  "talk.client.toolCall": async (request) => {
    const { params, respond } = request;
    if (
      !assertValidParams(params, validateTalkClientToolCallParams, "talk.client.toolCall", respond)
    ) {
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

    const config = request.context.getRuntimeConfig();
    const agentId = resolveTalkSessionAgentId(config, params.sessionKey);
    const creationError = authorizeGatewaySessionCreation({
      cfg: config,
      client: request.client,
      agentId,
    });
    if (creationError) {
      respond(false, undefined, creationError);
      return;
    }
    const relaySessionId = normalizeOptionalString(params.relaySessionId);
    const connId = normalizeOptionalString(request.client?.connId);
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
        (connId ? readLegacyVoiceBinding(connId, params.sessionKey) : undefined) ??
        resolveOpenClientVoiceSessionId({ agentId, sessionKey: params.sessionKey }) ??
        createOrResumeClientVoiceSession({
          agentId,
          sessionKey: params.sessionKey,
          origin: "client",
        });
      // Pin the resolved id to this connection so a legacy client's later consults
      // reuse one record instead of forking a new never-closed session each time.
      if (connId && !relaySessionId) {
        rememberLegacyVoiceBinding({ connId, sessionKey: params.sessionKey, voiceSessionId });
      }
      if (relaySessionId && connId) {
        await ensureClientVoiceAgentSessionEntry({
          agentId,
          sessionKey: params.sessionKey,
          creation: resolveSandboxedSessionCreation(request.client, config),
        });
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
  "talk.client.transcript": async ({ params, respond, context, sessionMutationAuthorization }) => {
    if (
      !assertValidParams(
        params,
        validateTalkClientTranscriptParams,
        "talk.client.transcript",
        respond,
      )
    ) {
      return;
    }
    try {
      const config = context.getRuntimeConfig();
      const target =
        sessionMutationAuthorization?.talkSessionTarget ??
        prepareTalkSessionTarget(config, params.sessionKey);
      sessionMutationAuthorization?.assertCurrent();
      await appendClientVoiceTranscript({
        agentId: target.agentId,
        sessionKey: target.sessionKey,
        sessionTarget: { sessionKey: target.canonicalKey, storePath: target.storePath },
        voiceSessionId: params.voiceSessionId,
        entryId: params.entryId,
        role: params.role,
        text: params.text,
        ...(params.timestamp !== undefined ? { timestamp: params.timestamp } : {}),
        config,
      });
      respond(true, { ok: true }, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, formatForLog(err)));
    }
  },
  "talk.client.close": async ({
    params,
    respond,
    context,
    client,
    sessionMutationAuthorization,
  }) => {
    if (!assertValidParams(params, validateTalkClientCloseParams, "talk.client.close", respond)) {
      return;
    }
    try {
      if (
        await closeTalkClientGatewayControlSession({
          voiceSessionId: params.voiceSessionId,
          sessionKey: params.sessionKey,
          connId: normalizeOptionalString(client?.connId),
        })
      ) {
        respond(true, { ok: true }, undefined);
        return;
      }
      const config = context.getRuntimeConfig();
      const { agentId } =
        sessionMutationAuthorization?.talkSessionTarget ??
        prepareTalkSessionTarget(config, params.sessionKey);
      sessionMutationAuthorization?.assertCurrent();
      const origin = resolveClientVoiceSessionOrigin({
        agentId,
        sessionKey: params.sessionKey,
        voiceSessionId: params.voiceSessionId,
      });
      if (origin === "relay") {
        throw new Error("relay-owned voice sessions close through talk.session.close");
      }
      await closeClientVoiceSession({
        agentId,
        sessionKey: params.sessionKey,
        voiceSessionId: params.voiceSessionId,
        config,
      });
      const connId = normalizeOptionalString(client?.connId);
      if (connId) {
        forgetLegacyVoiceBinding(connId, params.sessionKey, params.voiceSessionId);
      }
      respond(true, { ok: true }, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, formatForLog(err)));
    }
  },
  "talk.client.steer": async ({
    params,
    respond,
    client,
    context,
    sessionMutationAuthorization,
  }) => {
    if (!assertValidParams(params, validateTalkClientSteerParams, "talk.client.steer", respond)) {
      return;
    }
    try {
      const target =
        sessionMutationAuthorization?.talkSessionTarget ??
        prepareTalkSessionTarget(context.getRuntimeConfig(), params.sessionKey);
      const runTarget = resolveOwnedActiveTalkRunTarget({
        context,
        clientConnId: client?.connId,
        sessionTarget: target,
        assertCurrent: sessionMutationAuthorization?.assertCurrent,
      });
      if (runTarget === null) {
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
      const result = await controlRealtimeVoiceAgentRun({
        sessionKey: target.canonicalKey,
        runTarget,
        text: params.text,
        mode: params.mode,
      });
      respond(true, result, undefined);
    } catch (err) {
      if (err instanceof SessionMutationAuthorizationChangedError) {
        respond(false, undefined, err.error);
        return;
      }
      respond(
        false,
        undefined,
        errorShape(
          err instanceof AgentSelectionRequiredError
            ? ErrorCodes.INVALID_REQUEST
            : ErrorCodes.UNAVAILABLE,
          formatForLog(err),
        ),
      );
    }
  },
};
