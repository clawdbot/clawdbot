import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { readAcpSessionMeta } from "../../../acp/runtime/session-meta.js";
import { resolveSessionStorePathCore } from "../../../config/sessions/paths.js";
import {
  listSessionEntriesReadOnly,
  loadSessionEntryReadOnly,
  resolveSessionTranscriptRuntimeTarget,
} from "../../../config/sessions/session-accessor.js";
import type { SessionAcpMeta, SessionEntry } from "../../../config/sessions/types.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { formatErrorMessage } from "../../../infra/errors.js";
import { getSessionBindingService } from "../../../infra/outbound/session-binding-service.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import { isSubagentSessionKey, parseAgentSessionKey } from "../../../routing/session-key.js";
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
import type { SessionCapabilityStore } from "./subagent-capabilities.js";

const log = createSubsystemLogger("agents/acp-spawn");

type AcpSpawnRequesterContext = {
  agentChannel?: string;
  agentAccountId?: string;
  agentTo?: string;
  agentThreadId?: string | number;
  agentGroupSpace?: string | null;
  agentMemberRoleIds?: string[];
};

export type AcpSpawnRequesterState = {
  parentSessionKey?: string;
  isSubagentSession: boolean;
  hasActiveSubagentBinding: boolean;
  hasThreadContext: boolean;
  heartbeatEnabled: boolean;
  heartbeatRelayRouteUsable: boolean;
  origin: ReturnType<typeof normalizeDeliveryContext>;
};

type AcpSpawnStreamPlan = {
  implicitStreamToParent: boolean;
  effectiveStreamToParent: boolean;
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
  subagentStore?: SessionCapabilityStore;
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
    parentSessionKey: params.parentSessionKey,
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

export function resolveAcpSpawnStreamPlan(params: {
  spawnMode: "run" | "session";
  requestThreadBinding: boolean;
  streamToParentRequested: boolean;
  requester: AcpSpawnRequesterState;
}): AcpSpawnStreamPlan {
  // For mode=run without thread binding, implicitly route output to parent
  // only for spawned subagent orchestrator sessions with heartbeat enabled
  // AND a session-local heartbeat delivery route (target=last + usable last route).
  // Skip requester sessions that are thread-bound (or carrying thread context)
  // so user-facing threads do not receive unsolicited ACP progress chatter
  // unless streamTo="parent" is explicitly requested. Use resolved spawnMode
  // (not params.mode) so default mode selection works.
  const implicitStreamToParent =
    !params.streamToParentRequested &&
    params.spawnMode === "run" &&
    !params.requestThreadBinding &&
    params.requester.isSubagentSession &&
    !params.requester.hasActiveSubagentBinding &&
    !params.requester.hasThreadContext &&
    params.requester.heartbeatEnabled &&
    params.requester.heartbeatRelayRouteUsable;

  return {
    implicitStreamToParent,
    effectiveStreamToParent: params.streamToParentRequested || implicitStreamToParent,
  };
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

export function validateAcpResumeSessionOwnership(params: {
  cfg: OpenClawConfig;
  targetAgentId: string;
  requesterSessionKey?: string;
  resumeSessionId?: string;
}): { ok: true } | { ok: false; error: string } {
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

  const storePath = resolveSessionStorePathCore(params.cfg.session?.store, {
    agentId: params.targetAgentId,
  });
  for (const { sessionKey, entry } of listSessionEntriesReadOnly({ storePath, clone: false })) {
    const acp = readAcpSessionMeta({ sessionKey, cfg: params.cfg });
    if (!sessionEntryMatchesAcpResumeSessionId(acp, resumeSessionId)) {
      continue;
    }
    if (
      sessionEntryIsOwnedByRequester({
        sessionKey,
        entry,
        requesterSessionKey,
      })
    ) {
      return { ok: true };
    }
    break;
  }

  return {
    ok: false,
    error:
      "sessions_spawn resumeSessionId is only allowed for ACP sessions previously recorded for this requester. Omit resumeSessionId to start a fresh ACP session.",
  };
}
