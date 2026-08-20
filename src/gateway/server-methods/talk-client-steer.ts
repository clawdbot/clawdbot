import {
  ErrorCodes,
  errorShape,
  validateTalkClientSteerParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { AgentSelectionRequiredError } from "../../agents/agent-scope.js";
import { controlRealtimeVoiceAgentRun } from "../../talk/agent-run-control.js";
import { resolveTalkSessionAgentId } from "../../talk/agent-target.js";
import { resolveSessionStoreKey } from "../session-store-key.js";
import { formatForLog } from "../ws-log.js";
import { hasOwnedActiveTalkClientRun } from "./talk-client-run-ownership.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

export function resolveTalkClientAgentSessionTarget(
  config: Parameters<typeof resolveTalkSessionAgentId>[0],
  sessionKey: string,
) {
  const agentId = resolveTalkSessionAgentId(config, sessionKey);
  return {
    agentId,
    sessionKey: resolveSessionStoreKey({ cfg: config, sessionKey, storeAgentId: agentId }),
  };
}

export const talkClientSteerHandler: GatewayRequestHandlers["talk.client.steer"] = async ({
  params,
  respond,
  client,
  context,
}) => {
  if (!assertValidParams(params, validateTalkClientSteerParams, "talk.client.steer", respond)) {
    return;
  }
  try {
    const target = resolveTalkClientAgentSessionTarget(
      context.getRuntimeConfig(),
      params.sessionKey,
    );
    if (
      !hasOwnedActiveTalkClientRun({
        context,
        clientConnId: client?.connId,
        sessionKey: target.sessionKey,
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
    const result = await controlRealtimeVoiceAgentRun({
      sessionKey: target.sessionKey,
      text: params.text,
      mode: params.mode,
    });
    respond(true, result, undefined);
  } catch (err) {
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
};
