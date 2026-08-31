import {
  ErrorCodes,
  errorShape,
  validateTalkSessionAcknowledgeMarkParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { acknowledgeTalkRealtimeRelayMark } from "../talk-realtime-relay.js";
import { getUnifiedTalkSession, requireUnifiedTalkSessionConn } from "../talk-session-registry.js";
import { formatForLog } from "../ws-log.js";
import type { GatewayRequestHandler } from "./types.js";
import { assertValidParams } from "./validation.js";

export const acknowledgeTalkSessionMark: GatewayRequestHandler = ({ params, respond, client }) => {
  if (
    !assertValidParams(
      params,
      validateTalkSessionAcknowledgeMarkParams,
      "talk.session.acknowledgeMark",
      respond,
    )
  ) {
    return;
  }
  try {
    const session = getUnifiedTalkSession(params.sessionId);
    if (session.kind !== "realtime-relay") {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "talk.session.acknowledgeMark requires realtime relay",
        ),
      );
      return;
    }
    acknowledgeTalkRealtimeRelayMark({
      relaySessionId: session.relaySessionId,
      connId: requireUnifiedTalkSessionConn(session, client?.connId),
      markName: params.markName,
    });
    respond(true, { ok: true }, undefined);
  } catch (error) {
    const message = formatForLog(error);
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.UNAVAILABLE, message, {
        details: {
          talkIssue: { code: "realtime_unavailable", message, phase: "request" },
        },
      }),
    );
  }
};
