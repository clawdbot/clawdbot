import { validateSessionsDescribeParams } from "../../../packages/gateway-protocol/src/index.js";
import { createSessionIdentityMutationFence } from "../../sessions/session-lifecycle-events.js";
import { resolveRequestedSessionAgentId } from "../session-request-agent.js";
import { buildGatewaySessionRow } from "../session-utils.js";
import { readPreparedServerMethodModelCatalog } from "./optional-model-catalog.js";
import { readSessionPlacementFields } from "./session-placement-read-projection.js";
import { loadSessionEntriesForTarget, requireSessionKey } from "./sessions-shared.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

export const handleSessionsDescribe: GatewayRequestHandlers["sessions.describe"] = async ({
  params,
  respond,
  context,
}) => {
  if (!assertValidParams(params, validateSessionsDescribeParams, "sessions.describe", respond)) {
    return;
  }
  const key = requireSessionKey(params.key, respond);
  if (!key) {
    return;
  }
  const cfg = context.getRuntimeConfig();
  const requestedAgent = resolveRequestedSessionAgentId(cfg, key);
  if (!requestedAgent.ok) {
    return respond(false, undefined, requestedAgent.error);
  }
  const initial = loadSessionEntriesForTarget({
    key,
    cfg,
    ...(requestedAgent.agentId ? { agentId: requestedAgent.agentId } : {}),
  });
  if (!initial.entry) {
    return respond(true, { session: null }, undefined);
  }
  const identityMutationFence = createSessionIdentityMutationFence({
    sessionKey: initial.target.canonicalKey,
    sessionId: initial.entry.sessionId,
  });
  try {
    const preparedCatalog = await readPreparedServerMethodModelCatalog(context, {
      agentId: initial.target.agentId,
    });
    const identityIsCurrent = identityMutationFence.isCurrent();
    const current = identityIsCurrent
      ? initial
      : loadSessionEntriesForTarget({
          key,
          cfg,
          ...(requestedAgent.agentId ? { agentId: requestedAgent.agentId } : {}),
        });
    if (!current.entry) {
      return respond(true, { session: null }, undefined);
    }
    const row = buildGatewaySessionRow({
      cfg,
      storePath: current.storePath,
      store: current.store,
      key: current.target.canonicalKey,
      entry: current.entry,
      agentId: current.target.agentId,
      ...(identityIsCurrent && preparedCatalog !== undefined
        ? { modelCatalog: preparedCatalog.entries }
        : {}),
      includeDerivedTitles: params.includeDerivedTitles,
      includeLastMessage: params.includeLastMessage,
      transcriptUsageMaxBytes: 64 * 1024,
    });
    respond(true, { session: { ...row, ...readSessionPlacementFields(context, row.sessionId) } });
  } finally {
    identityMutationFence.release();
  }
};
