import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import {
  readAcpSessionMetaBatch,
  writeAcpSessionMetaForMigration,
} from "../../../acp/runtime/session-meta.js";
import { resolveSessionStorePathCore } from "../../../config/sessions/paths.js";
import {
  listSessionEntriesReadOnly,
  loadSessionEntryReadOnly,
  resolveSessionTranscriptRuntimeTarget,
  upsertSessionEntryCore,
} from "../../../config/sessions/session-accessor.js";
import type { SessionAcpMeta, SessionEntry } from "../../../config/sessions/types.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { formatErrorMessage } from "../../../infra/errors.js";
import { getSessionBindingService } from "../../../infra/outbound/session-binding-service.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import {
  isSubagentSessionKey,
  parseAgentSessionKey,
  toAgentStoreSessionKey,
} from "../../../routing/session-key.js";
import { normalizeDeliveryContext } from "../../../utils/delivery-context.shared.js";
import { resolveRequesterOriginForChild } from "../../spawn-requester-origin.js";
import {
  resolveInternalSessionKey,
  resolveMainSessionAlias,
} from "../../tools/sessions-helpers.js";
import {
  hasSessionLocalHeartbeatRelayRoute,
  isHeartbeatEnabledForSessionAgent,
} from "./acp-spawn-heartbeat.js";

const log = createSubsystemLogger("agents/acp-spawn");

// Owner/harness separation shipped after legacy ACP sessions had already been stored under the
// harness. Keep the compatibility reader explicitly time-bounded; matched rows are promoted into
// the canonical owner store so subsequent resumes no longer depend on the legacy namespace.
const LEGACY_ACP_HARNESS_STORE_MIGRATION_DEADLINE_MS = Date.parse("2027-03-01T00:00:00Z");

type AcpSpawnRequesterContext = {
  agentChannel?: string;
  agentAccountId?: string;
  agentTo?: string;
  agentThreadId?: string | number;
  agentGroupSpace?: string | null;
  agentMemberRoleIds?: string[];
};

export type AcpSpawnRequesterState = {
  isSubagentSession: boolean;
  hasActiveSubagentBinding: boolean;
  hasThreadContext: boolean;
  heartbeatEnabled: boolean;
  heartbeatRelayRouteUsable: boolean;
  origin: ReturnType<typeof normalizeDeliveryContext>;
};

export function resolveRequesterInternalSessionKey(params: {
  cfg: OpenClawConfig;
  requesterSessionKey?: string;
}): string {
  const { mainKey, alias } = resolveMainSessionAlias(params.cfg);
  const requesterSessionKey = normalizeOptionalString(params.requesterSessionKey);
  return requesterSessionKey
    ? resolveInternalSessionKey({
        key: requesterSessionKey,
        alias,
        mainKey,
      })
    : alias;
}

export async function persistAcpSpawnSessionFileBestEffort(params: {
  sessionId: string;
  sessionKey: string;
  sessionEntry: SessionEntry | undefined;
  storePath: string;
  agentId: string;
  threadId?: string | number;
  stage: "spawn" | "thread-bind";
}): Promise<SessionEntry | undefined> {
  try {
    const resolvedSessionFile = await resolveSessionTranscriptRuntimeTarget({
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      storePath: params.storePath,
      agentId: params.agentId,
      threadId: params.threadId,
    });
    return (
      loadSessionEntryReadOnly({
        storePath: params.storePath,
        sessionKey: resolvedSessionFile.sessionKey,
        clone: false,
      }) ?? params.sessionEntry
    );
  } catch (error) {
    log.warn(
      `ACP session-file persistence failed during ${params.stage} for ${params.sessionKey}: ${formatErrorMessage(error)}`,
    );
    return params.sessionEntry;
  }
}

export function resolveAcpSpawnRequesterState(params: {
  cfg: OpenClawConfig;
  parentSessionKey?: string;
  requesterAgentId: string;
  targetAgentId: string;
  ctx: AcpSpawnRequesterContext;
}): AcpSpawnRequesterState {
  const bindingService = getSessionBindingService();
  const requesterParsedSession = parseAgentSessionKey(params.parentSessionKey);
  const isSubagentSession =
    Boolean(requesterParsedSession) && isSubagentSessionKey(params.parentSessionKey);
  const hasActiveSubagentBinding =
    isSubagentSession && params.parentSessionKey
      ? bindingService
          .listBySession(params.parentSessionKey)
          .some((record) => record.targetKind === "subagent" && record.status !== "ended")
      : false;
  const hasThreadContext =
    typeof params.ctx.agentThreadId === "string"
      ? Boolean(normalizeOptionalString(params.ctx.agentThreadId))
      : params.ctx.agentThreadId != null;
  return {
    isSubagentSession,
    hasActiveSubagentBinding,
    hasThreadContext,
    heartbeatEnabled: isHeartbeatEnabledForSessionAgent({
      cfg: params.cfg,
      requesterAgentId: params.requesterAgentId,
      sessionKey: params.parentSessionKey,
    }),
    heartbeatRelayRouteUsable:
      params.parentSessionKey && params.requesterAgentId
        ? hasSessionLocalHeartbeatRelayRoute({
            cfg: params.cfg,
            parentSessionKey: params.parentSessionKey,
            requesterAgentId: params.requesterAgentId,
          })
        : false,
    origin: resolveRequesterOriginForChild({
      cfg: params.cfg,
      targetAgentId: params.targetAgentId,
      requesterAgentId: params.requesterAgentId,
      requesterChannel: params.ctx.agentChannel,
      requesterAccountId: params.ctx.agentAccountId,
      requesterTo: params.ctx.agentTo,
      requesterThreadId: params.ctx.agentThreadId,
      requesterGroupSpace: params.ctx.agentGroupSpace,
      requesterMemberRoleIds: params.ctx.agentMemberRoleIds,
    }),
  };
}

export function shouldStreamAcpSpawnToParent(params: {
  spawnMode: "run" | "session";
  requestThreadBinding: boolean;
  streamToParentRequested: boolean;
  requester: AcpSpawnRequesterState;
}): boolean {
  // For mode=run without thread binding, implicitly route output to parent
  // only for spawned subagent orchestrator sessions with heartbeat enabled
  // AND a session-local heartbeat delivery route (target=last + usable last route).
  // Skip requester sessions that are thread-bound (or carrying thread context)
  // so user-facing threads do not receive unsolicited ACP progress chatter
  // unless streamTo="parent" is explicitly requested. Use resolved spawnMode
  // (not params.mode) so default mode selection works.
  const implicitStreamToParent =
    params.spawnMode === "run" &&
    !params.requestThreadBinding &&
    params.requester.isSubagentSession &&
    !params.requester.hasActiveSubagentBinding &&
    !params.requester.hasThreadContext &&
    params.requester.heartbeatEnabled &&
    params.requester.heartbeatRelayRouteUsable;

  return params.streamToParentRequested || implicitStreamToParent;
}

function sessionEntryMatchesAcpResumeSessionId(
  acp: SessionAcpMeta | undefined,
  resumeSessionId: string,
): boolean {
  const identity = acp?.identity;
  return (
    normalizeOptionalString(identity?.agentSessionId) === resumeSessionId ||
    normalizeOptionalString(identity?.acpxSessionId) === resumeSessionId
  );
}

function sessionEntryIsOwnedByRequester(params: {
  sessionKey: string;
  entry: SessionEntry | undefined;
  requesterSessionKey: string;
}): boolean {
  return (
    params.sessionKey === params.requesterSessionKey ||
    normalizeOptionalString(params.entry?.spawnedBy) === params.requesterSessionKey ||
    normalizeOptionalString(params.entry?.parentSessionKey) === params.requesterSessionKey
  );
}

function resolveStoredSessionOwner(
  sessionKey: string,
  storeOwners: ReadonlySet<string>,
): string | undefined {
  const parsed = parseAgentSessionKey(sessionKey);
  if (parsed?.agentId) {
    return parsed.agentId;
  }
  if (sessionKey.trim().toLowerCase().startsWith("agent:")) {
    return undefined;
  }
  if (storeOwners.size !== 1) {
    return undefined;
  }
  return storeOwners.values().next().value;
}

async function promoteLegacyAcpResumeEntry(params: {
  cfg: OpenClawConfig;
  entry: SessionEntry;
  harnessSessionKey: string;
  meta: SessionAcpMeta;
  sessionOwnerAgentId: string;
}): Promise<boolean> {
  const parsed = parseAgentSessionKey(params.harnessSessionKey);
  const ownerSessionKey = parsed?.rest
    ? `agent:${params.sessionOwnerAgentId}:${parsed.rest}`
    : toAgentStoreSessionKey({
        agentId: params.sessionOwnerAgentId,
        requestKey: params.harnessSessionKey,
      });
  const ownerStorePath = resolveSessionStorePathCore(params.cfg.session?.store, {
    agentId: params.sessionOwnerAgentId,
  });
  if (
    loadSessionEntryReadOnly({
      agentId: params.sessionOwnerAgentId,
      storePath: ownerStorePath,
      sessionKey: ownerSessionKey,
      clone: false,
    })
  ) {
    return false;
  }
  try {
    writeAcpSessionMetaForMigration({
      sessionKey: ownerSessionKey,
      sessionId: params.entry.sessionId,
      lifecycleRevision: params.entry.lifecycleRevision,
      meta: params.meta,
    });
  } catch (error) {
    log.warn(
      `ACP legacy owner promotion metadata write failed for ${ownerSessionKey}: ${formatErrorMessage(error)}`,
    );
    return false;
  }
  const promoted = await upsertSessionEntryCore(
    {
      agentId: params.sessionOwnerAgentId,
      storePath: ownerStorePath,
      sessionKey: ownerSessionKey,
    },
    params.entry,
  );
  if (!promoted) {
    return false;
  }
  return true;
}

export async function validateAcpResumeSessionOwnership(params: {
  cfg: OpenClawConfig;
  sessionOwnerAgentId: string;
  harnessAgentId: string;
  backendId?: string;
  requesterSessionKey?: string;
  resumeSessionId?: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const resumeSessionId = normalizeOptionalString(params.resumeSessionId);
  if (!resumeSessionId) {
    return { ok: true };
  }
  const requesterSessionKey = normalizeOptionalString(params.requesterSessionKey);
  if (!requesterSessionKey) {
    return {
      ok: false,
      error: "sessions_spawn resumeSessionId requires an active requester session context.",
    };
  }

  const configuredBackend = normalizeOptionalLowercaseString(params.backendId);
  const storeSearchesByPath = new Map<
    string,
    { allowedOwners: Set<string>; possibleOwners: Set<string> }
  >();
  const registerStoreOwner = (storeAgentId: string, allowed: boolean) => {
    const storePath = resolveSessionStorePathCore(params.cfg.session?.store, {
      agentId: storeAgentId,
    });
    const search = storeSearchesByPath.get(storePath) ?? {
      allowedOwners: new Set<string>(),
      possibleOwners: new Set<string>(),
    };
    search.possibleOwners.add(storeAgentId);
    if (allowed) {
      search.allowedOwners.add(storeAgentId);
    }
    storeSearchesByPath.set(storePath, search);
  };
  registerStoreOwner(params.sessionOwnerAgentId, true);
  if (params.harnessAgentId !== params.sessionOwnerAgentId) {
    registerStoreOwner(
      params.harnessAgentId,
      Date.now() < LEGACY_ACP_HARNESS_STORE_MIGRATION_DEADLINE_MS,
    );
  }
  for (const [storePath, { allowedOwners, possibleOwners }] of storeSearchesByPath) {
    if (allowedOwners.size === 0) {
      continue;
    }
    const entries = listSessionEntriesReadOnly({ storePath, clone: false });
    const entryOwners = new Map(
      entries.map(({ sessionKey, entry }) => [
        entry,
        resolveStoredSessionOwner(sessionKey, possibleOwners),
      ]),
    );
    const metaByEntry = readAcpSessionMetaBatch({
      entries: entries.flatMap(({ sessionKey, entry }) => {
        const agentId = entryOwners.get(entry);
        return agentId ? [{ sessionKey, agentId, entry }] : [];
      }),
      cfg: params.cfg,
    });
    for (const { sessionKey, entry } of entries) {
      const entryOwnerAgentId = entryOwners.get(entry);
      if (!entryOwnerAgentId || !allowedOwners.has(entryOwnerAgentId)) {
        continue;
      }
      const acp = metaByEntry.get(entry);
      // Resume identifiers are backend-local; requester ownership cannot authorize another backend.
      if (
        !acp ||
        (configuredBackend &&
          normalizeOptionalLowercaseString(acp?.backend) !== configuredBackend) ||
        // An owner alias is mutable and cannot prove which harness created a legacy record.
        // Fail closed unless persisted metadata names the currently requested harness.
        normalizeOptionalString(acp?.agent) !== params.harnessAgentId ||
        !sessionEntryMatchesAcpResumeSessionId(acp, resumeSessionId)
      ) {
        continue;
      }
      if (
        sessionEntryIsOwnedByRequester({
          sessionKey,
          entry,
          requesterSessionKey,
        })
      ) {
        if (
          entryOwnerAgentId !== params.sessionOwnerAgentId &&
          !(await promoteLegacyAcpResumeEntry({
            cfg: params.cfg,
            entry,
            harnessSessionKey: sessionKey,
            meta: acp,
            sessionOwnerAgentId: params.sessionOwnerAgentId,
          }))
        ) {
          break;
        }
        return { ok: true };
      }
    }
  }

  return {
    ok: false,
    error:
      "sessions_spawn resumeSessionId is only allowed for ACP sessions previously recorded for this requester. Omit resumeSessionId to start a fresh ACP session.",
  };
}
