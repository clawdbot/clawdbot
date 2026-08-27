import { validateSessionsDescribeParams } from "../../../packages/gateway-protocol/src/index.js";
import { resolveRequestedSessionAgentId } from "../session-request-agent.js";
import { buildGatewaySessionRow } from "../session-utils.js";
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
  const { target, storePath, store, entry } = loadSessionEntriesForTarget({
    key,
    cfg,
    ...(requestedAgent.agentId ? { agentId: requestedAgent.agentId } : {}),
  });
  if (!entry) {
    return respond(true, { session: null }, undefined);
  }
  const modelCatalog = await context
    .loadGatewayModelCatalog({ agentId: target.agentId })
    .catch(() => undefined);
  const row = buildGatewaySessionRow({
    cfg,
    storePath,
    store,
    key: target.canonicalKey,
    entry,
    agentId: target.agentId,
    ...(modelCatalog !== undefined ? { modelCatalog } : {}),
    includeDerivedTitles: params.includeDerivedTitles,
    includeLastMessage: params.includeLastMessage,
    transcriptUsageMaxBytes: 64 * 1024,
  });
  respond(true, { session: { ...row, ...readSessionPlacementFields(context, row.sessionId) } });
};
