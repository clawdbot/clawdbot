import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import { resolvePersistedSessionStoreOwnerForKey } from "../../config/sessions/session-store-owner.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  normalizeAgentId,
  parseAgentSessionKey,
  resolveAgentIdFromSessionKey,
  toAgentStoreSessionKey,
} from "../../routing/session-key.js";
import { getTaskSessionLookupByIdForStatus } from "../../tasks/task-status-access.js";
import { hasOperatorBoundary } from "../operator-role-policy.js";
import { resolveSessionKeyForRun } from "../server-session-key.js";
import { resolveRequestedSessionAgentId } from "../session-request-agent.js";
import {
  authorizeIncognitoSessionTarget,
  createSessionListEntryFilter,
  resolveSessionSharingTarget,
} from "../session-sharing.js";
import {
  resolveSessionStoreAgentId,
  resolveStoredSessionKeyForAgentStore,
} from "../session-store-key.js";
import type { GatewayClient } from "./types.js";

export type ArtifactQuery = {
  sessionKey?: string;
  runId?: string;
  taskId?: string;
  agentId?: string;
};

type ResolvedArtifactSession = {
  sessionKey: string;
  agentId?: string;
};

function resolveArtifactSessionAgentId(
  sessionKey: string | undefined,
  cfg?: OpenClawConfig,
): string | undefined {
  const key = normalizeOptionalString(sessionKey);
  if (!key) {
    return undefined;
  }
  const parsed = parseAgentSessionKey(key);
  if (!parsed && key.toLowerCase().startsWith("agent:")) {
    return undefined;
  }
  if (cfg) {
    const owner = resolveRequestedSessionAgentId(cfg, key);
    if (!owner.ok) {
      throw new ArtifactSessionResolutionError(owner.error);
    }
    return owner.agentId;
  }
  return parsed?.agentId ?? resolveAgentIdFromSessionKey(key);
}

function resolveScopedArtifactSessionKey(
  sessionKey: string | undefined,
  agentId: string | undefined,
  cfg?: OpenClawConfig,
): string | undefined {
  const key = normalizeOptionalString(sessionKey);
  if (!key) {
    return undefined;
  }
  const scopedAgentId = normalizeOptionalString(agentId);
  if (!scopedAgentId) {
    return key;
  }
  const parsed = parseAgentSessionKey(key);
  if (!parsed && key.toLowerCase().startsWith("agent:")) {
    return undefined;
  }
  if (!cfg) {
    return parsed && parsed.agentId !== normalizeAgentId(scopedAgentId)
      ? undefined
      : toAgentStoreSessionKey({ agentId: scopedAgentId, requestKey: key });
  }
  const scopedKey = resolveStoredSessionKeyForAgentStore({
    cfg,
    agentId: scopedAgentId,
    sessionKey: key,
  });
  return scopedKey !== "global" &&
    scopedKey !== "unknown" &&
    resolveSessionStoreAgentId(cfg, scopedKey) !== normalizeAgentId(scopedAgentId)
    ? undefined
    : scopedKey;
}

function resolveQuerySession(
  query: ArtifactQuery,
  cfg?: OpenClawConfig,
): ResolvedArtifactSession | undefined {
  if (query.sessionKey) {
    const sessionKey = resolveScopedArtifactSessionKey(query.sessionKey, query.agentId, cfg);
    return sessionKey
      ? { sessionKey, ...(query.agentId ? { agentId: query.agentId } : {}) }
      : undefined;
  }
  if (query.runId) {
    // A live run context can resolve its own agent-scoped key. Do not force an
    // unrelated default-agent selection before consulting that authoritative row.
    const sessionKey = resolveSessionKeyForRun(
      query.runId,
      query.agentId ? { agentId: query.agentId } : {},
    );
    const agentId =
      query.agentId ??
      resolveArtifactSessionAgentId(sessionKey, cfg) ??
      resolveSessionAgentId({ config: cfg });
    const scopedSessionKey = resolveScopedArtifactSessionKey(sessionKey, agentId, cfg);
    return scopedSessionKey ? { sessionKey: scopedSessionKey, agentId } : undefined;
  }
  if (!query.taskId) {
    return undefined;
  }
  const task = getTaskSessionLookupByIdForStatus(query.taskId);
  const requesterSessionKey = normalizeOptionalString(task?.requesterSessionKey);
  const ownerAgentId = parseAgentSessionKey(task?.ownerKey)?.agentId;
  const persistedRequesterOwner = requesterSessionKey
    ? resolvePersistedSessionStoreOwnerForKey(cfg ?? {}, requesterSessionKey)
    : { kind: "none" as const };
  const requesterAgentId =
    normalizeOptionalString(task?.requesterAgentId) ??
    ownerAgentId ??
    (persistedRequesterOwner.kind === "configured"
      ? persistedRequesterOwner.agentId
      : resolveArtifactSessionAgentId(requesterSessionKey, cfg));
  const taskAgentId = normalizeOptionalString(task?.agentId) ?? requesterAgentId;
  if (
    query.agentId &&
    taskAgentId &&
    normalizeAgentId(query.agentId) !== normalizeAgentId(taskAgentId)
  ) {
    return undefined;
  }
  if (requesterSessionKey) {
    // task.agentId identifies the executor. requesterAgentId keeps global
    // requester transcripts in the correct agent store across restarts.
    const sessionAgentId =
      requesterAgentId ?? resolveArtifactSessionAgentId(requesterSessionKey, cfg);
    const scopedSessionKey = sessionAgentId
      ? resolveScopedArtifactSessionKey(requesterSessionKey, sessionAgentId, cfg)
      : undefined;
    return scopedSessionKey ? { sessionKey: scopedSessionKey, agentId: sessionAgentId } : undefined;
  }
  const agentId = query.agentId ?? taskAgentId ?? resolveSessionAgentId({ config: cfg });
  const runId = normalizeOptionalString(task?.runId);
  const sessionKey = runId ? resolveSessionKeyForRun(runId, { agentId }) : undefined;
  const scopedSessionKey = resolveScopedArtifactSessionKey(sessionKey, agentId, cfg);
  return scopedSessionKey ? { sessionKey: scopedSessionKey, agentId } : undefined;
}

export class ArtifactSessionResolutionError extends Error {
  constructor(readonly shape: ReturnType<typeof errorShape>) {
    super(shape.message);
  }
}

export function resolveAuthorizedArtifactSession(
  query: ArtifactQuery,
  cfg: OpenClawConfig | undefined,
  client: GatewayClient | null,
): ResolvedArtifactSession | undefined {
  const resolved = resolveQuerySession(query, cfg);
  if (!resolved) {
    return undefined;
  }
  const target = resolveSessionSharingTarget({
    cfg: cfg ?? {},
    sessionKey: resolved.sessionKey,
    agentId: resolved.agentId,
  });
  const error = authorizeIncognitoSessionTarget({
    client,
    sessionKey: query.sessionKey ?? resolved.sessionKey,
    target,
  });
  const roleVisibilityDenied = Boolean(
    cfg &&
    hasOperatorBoundary(client, cfg) &&
    target &&
    createSessionListEntryFilter({ client, cfg })?.(target.storeKey, target.entry) === false,
  );
  if (!error && !roleVisibilityDenied) {
    return resolved;
  }
  throw new ArtifactSessionResolutionError(
    query.sessionKey && error
      ? error
      : errorShape(ErrorCodes.INVALID_REQUEST, "no session found for artifact query", {
          details: { type: "artifact_scope_not_found" },
        }),
  );
}
