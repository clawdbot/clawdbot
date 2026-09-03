import type { SessionsListParams } from "../../../packages/gateway-protocol/src/index.js";
import { listBoardSessionKeysReadOnly } from "../../boards/sqlite-board-store.js";
import type { SessionEntry } from "../../config/sessions.js";
import { resolveSqliteTargetFromSessionStorePath } from "../../config/sessions/session-sqlite-target.js";
import { normalizeAgentId, parseAgentSessionKey } from "../../routing/session-key.js";
import { listOpenIncognitoAgentDatabases } from "../../state/openclaw-agent-db.js";
import { prepareSessionSharing } from "../session-sharing.js";

function listBoardSessionKeysByAgent(
  durableTargets: ReadonlyArray<{ agentId: string; storePath: string }>,
  requestedAgentId?: string,
): ReadonlyMap<string, ReadonlySet<string>> {
  const normalizedRequestedAgentId = requestedAgentId
    ? normalizeAgentId(requestedAgentId)
    : undefined;
  const incognitoTargets = listOpenIncognitoAgentDatabases().filter(
    (target) => !normalizedRequestedAgentId || target.agentId === normalizedRequestedAgentId,
  );
  const byAgent = new Map<string, Set<string>>();
  for (const target of [...durableTargets, ...incognitoTargets]) {
    const databaseTarget = resolveSqliteTargetFromSessionStorePath(target.storePath, {
      agentId: target.agentId,
    });
    const databaseAgentId = normalizeAgentId(databaseTarget.agentId ?? target.agentId);
    for (const sessionKey of listBoardSessionKeysReadOnly({
      agentId: databaseAgentId,
      path: databaseTarget.path,
    })) {
      // Shared databases persist qualified keys for each logical owner. Unqualified
      // global keys retain the target owner, matching the combined session projection.
      const agentId = normalizeAgentId(parseAgentSessionKey(sessionKey)?.agentId ?? target.agentId);
      const keys = byAgent.get(agentId) ?? new Set<string>();
      keys.add(sessionKey);
      byAgent.set(agentId, keys);
    }
  }
  return byAgent;
}

type LoadedSessionStore = {
  agentIdBySessionKey: ReadonlyMap<string, string>;
  durableTargets: ReadonlyArray<{ agentId: string; storePath: string }>;
};

export function listFilter(input: {
  cfg: Parameters<typeof prepareSessionSharing>[0]["cfg"];
  client: Parameters<typeof prepareSessionSharing>[0]["client"];
  defaultsAgentId: string;
  loaded: LoadedSessionStore;
  options: { excludedKeys?: ReadonlySet<string> };
  p: SessionsListParams;
}): ((key: string, entry: SessionEntry) => boolean) | undefined {
  const { loaded, p: params } = input;
  const visibilityFilter = prepareSessionSharing({
    client: input.client,
    cfg: input.cfg,
  }).entryFilter;
  const excludedKeys = input.options.excludedKeys;
  const boardSessionKeysByAgent =
    params.hasBoard === undefined
      ? undefined
      : listBoardSessionKeysByAgent(loaded.durableTargets, params.agentId);
  if (!visibilityFilter && !boardSessionKeysByAgent && !excludedKeys?.size) {
    return undefined;
  }
  return (key, entry) => {
    const agentId = normalizeAgentId(
      loaded.agentIdBySessionKey.get(key) ??
        parseAgentSessionKey(key)?.agentId ??
        input.defaultsAgentId,
    );
    const hasBoard = boardSessionKeysByAgent?.get(agentId)?.has(key) ?? false;
    return (
      !excludedKeys?.has(key) &&
      (visibilityFilter?.(key, entry) ?? true) &&
      (params.hasBoard === undefined || hasBoard === params.hasBoard)
    );
  };
}
