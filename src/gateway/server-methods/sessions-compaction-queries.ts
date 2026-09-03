// Read-only compaction checkpoint queries.
import { validateSessionsCompactionListParams } from "../../../packages/gateway-protocol/src/index.js";
import { listSessionCompactionCheckpoints } from "../session-compaction-checkpoints.js";
import { resolveRequestedSessionAgentId as resolveRequestedGlobalAgentId } from "../session-request-agent.js";
import { loadAccessorSessionEntryForGatewayTarget, requireSessionKey } from "./sessions-shared.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

export const sessionCheckpointQueryHandlers: GatewayRequestHandlers = {
  "sessions.compaction.list": ({ params, respond, context }) => {
    if (
      !assertValidParams(
        params,
        validateSessionsCompactionListParams,
        "sessions.compaction.list",
        respond,
      )
    ) {
      return;
    }
    const p = params;
    const key = requireSessionKey(p.key, respond);
    if (!key) {
      return;
    }
    const cfg = context.getRuntimeConfig();
    const requestedAgent = resolveRequestedGlobalAgentId(cfg, key, p.agentId);
    if (!requestedAgent.ok) {
      respond(false, undefined, requestedAgent.error);
      return;
    }
    const { entry, canonicalKey } = loadAccessorSessionEntryForGatewayTarget({
      key,
      cfg,
      agentId: requestedAgent.agentId,
    });
    respond(
      true,
      {
        ok: true,
        key: canonicalKey,
        checkpoints: listSessionCompactionCheckpoints(entry),
      },
      undefined,
    );
  },
};
