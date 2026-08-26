import {
  ErrorCodes,
  errorShape,
  validateSessionsTrajectoryDetailParams,
  validateSessionsTrajectoryPageParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import { readTrajectoryDetail, readTrajectoryPage } from "../../trajectory/read-model.js";
import { loadGatewaySessionEntryReadOnly } from "../session-utils.js";
import { resolveRequestedChatAgentId } from "./chat-origin-routing.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

function resolveTrajectoryTarget(params: {
  sessionKey: string;
  agentId?: string;
  cfg: Parameters<typeof resolveSessionAgentId>[0]["config"];
}) {
  const requestedAgent = resolveRequestedChatAgentId({
    cfg: params.cfg,
    requestedSessionKey: params.sessionKey,
    agentId: params.agentId,
  });
  if (!requestedAgent.ok) {
    return requestedAgent;
  }
  const agentId = resolveSessionAgentId({
    sessionKey: params.sessionKey,
    config: params.cfg,
    agentId: requestedAgent.agentId,
  });
  const loaded = loadGatewaySessionEntryReadOnly(params.sessionKey, { agentId });
  if (!loaded.entry?.sessionId) {
    return {
      ok: false as const,
      error: errorShape(ErrorCodes.INVALID_REQUEST, "session trajectory is unavailable"),
    };
  }
  return {
    ok: true as const,
    target: {
      agentId: loaded.agentId,
      sessionId: loaded.entry.sessionId,
      sessionKey: loaded.canonicalKey,
      storePath: loaded.storePath,
    },
  };
}

export const trajectoryHandlers: GatewayRequestHandlers = {
  "sessions.trajectory.page": ({ params, respond, context }) => {
    if (
      !assertValidParams(
        params,
        validateSessionsTrajectoryPageParams,
        "sessions.trajectory.page",
        respond,
      )
    ) {
      return;
    }
    const cfg = context.getRuntimeConfig();
    if (cfg.gateway?.controlUi?.trajectory !== true) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.UNAVAILABLE,
          "Trajectory view is disabled. Enable it in Settings > Labs.",
        ),
      );
      return;
    }
    const resolved = resolveTrajectoryTarget({
      cfg,
      sessionKey: params.sessionKey,
      agentId: params.agentId,
    });
    if (!resolved.ok) {
      respond(false, undefined, resolved.error);
      return;
    }
    respond(
      true,
      readTrajectoryPage({
        target: resolved.target,
        cursor: params.cursor,
        limit: params.limit,
      }),
    );
  },
  "sessions.trajectory.detail": ({ params, respond, context }) => {
    if (
      !assertValidParams(
        params,
        validateSessionsTrajectoryDetailParams,
        "sessions.trajectory.detail",
        respond,
      )
    ) {
      return;
    }
    const cfg = context.getRuntimeConfig();
    if (cfg.gateway?.controlUi?.trajectory !== true) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.UNAVAILABLE,
          "Trajectory view is disabled. Enable it in Settings > Labs.",
        ),
      );
      return;
    }
    const resolved = resolveTrajectoryTarget({
      cfg,
      sessionKey: params.sessionKey,
      agentId: params.agentId,
    });
    if (!resolved.ok) {
      respond(false, undefined, resolved.error);
      return;
    }
    respond(true, readTrajectoryDetail({ target: resolved.target, recordId: params.recordId }));
  },
};
