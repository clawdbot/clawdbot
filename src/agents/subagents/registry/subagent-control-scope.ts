/** Controller identity, authorization, and controlled-run read scope. */
import { sortSubagentRuns } from "../../../auto-reply/reply/subagents-utils.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import {
  isSubagentSessionKey,
  normalizeAgentId,
  parseAgentSessionKey,
} from "../../../routing/session-key.js";
import { resolveSessionAgentId } from "../../agent-scope.js";
import { resolveSubagentRequesterAgentId } from "../../subagent-requester-owner.js";
import {
  resolveInternalSessionKey,
  resolveMainSessionAlias,
} from "../../tools/sessions-helpers.js";
import { resolveStoredSubagentCapabilities } from "../spawn/subagent-capabilities.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { buildSubagentRunReadIndexFromRuns } from "./subagent-registry-queries.js";
import { getLatestLiveSubagentRunByChildSessionKey } from "./subagent-registry-read.js";
import { getSubagentRunsSnapshotForRead } from "./subagent-registry-state.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

/** Recent-run default window used by subagent control UI/tools. */
export const DEFAULT_RECENT_MINUTES = 30;
/** Maximum recent-run window accepted by subagent control UI/tools. */
export const MAX_RECENT_MINUTES = 24 * 60;

/** Controller identity and capability scope resolved from the caller session. */
export type ResolvedSubagentController = {
  controllerSessionKey: string;
  controllerAgentId?: string;
  callerSessionKey: string;
  callerIsSubagent: boolean;
  controlScope: "children" | "none";
};

/** Resolves which subagent runs the caller is allowed to control. */
export function resolveSubagentController(params: {
  cfg: OpenClawConfig;
  agentSessionKey?: string;
  agentId?: string;
}): ResolvedSubagentController {
  const { mainKey, alias } = resolveMainSessionAlias(params.cfg);
  const callerRaw = params.agentSessionKey?.trim() || alias;
  const callerSessionKey = resolveInternalSessionKey({
    key: callerRaw,
    alias,
    mainKey,
  });
  const controllerAgentId = resolveSessionAgentId({
    config: params.cfg,
    sessionKey: callerSessionKey,
    agentId: params.agentId,
  });
  if (!isSubagentSessionKey(callerSessionKey)) {
    return {
      controllerSessionKey: callerSessionKey,
      controllerAgentId,
      callerSessionKey,
      callerIsSubagent: false,
      controlScope: "children",
    };
  }
  const capabilities = resolveStoredSubagentCapabilities(callerSessionKey, {
    cfg: params.cfg,
    agentId: controllerAgentId,
  });
  return {
    controllerSessionKey: callerSessionKey,
    controllerAgentId,
    callerSessionKey,
    callerIsSubagent: true,
    controlScope: capabilities.controlScope,
  };
}

function resolveRunRequesterAgentId(
  entry: SubagentRunRecord,
  cfg?: OpenClawConfig,
): string | undefined {
  if (entry.requesterAgentId) {
    return entry.requesterAgentId;
  }
  const parsed = parseAgentSessionKey(entry.requesterSessionKey)?.agentId;
  if (parsed || !cfg) {
    return parsed;
  }
  return resolveSubagentRequesterAgentId(cfg, entry);
}

function isSubagentRunVisibleToSession(
  entry: SubagentRunRecord,
  sessionKey: string,
  agentId: string,
  cfg?: OpenClawConfig,
): boolean {
  const controllerKey = entry.controllerSessionKey?.trim();
  const requesterKey = entry.requesterSessionKey.trim();
  // Completion routing can target a different session than control ownership.
  // Both owners may read the run, while ensureControllerOwnsRun still gates mutations.
  const requesterAgentId = resolveRunRequesterAgentId(entry, cfg);
  const controllerAgentId =
    (controllerKey ? parseAgentSessionKey(controllerKey)?.agentId : undefined) ?? requesterAgentId;
  const normalizedAgentId = normalizeAgentId(agentId);
  return (
    (controllerKey === sessionKey && controllerAgentId === normalizedAgentId) ||
    (requesterKey === sessionKey && requesterAgentId === normalizedAgentId)
  );
}

/** Builds one stable snapshot for controlled-run listing and descendant status reads. */
export function buildControlledSubagentRunsReadContext(
  controllerSessionKey: string,
  controllerAgentId?: string,
  cfg?: OpenClawConfig,
): {
  runs: SubagentRunRecord[];
  countPendingDescendantRuns(rootSessionKey: string): number;
} {
  const key = controllerSessionKey.trim();
  const agentId = controllerAgentId ?? parseAgentSessionKey(key)?.agentId;
  if (!key || !agentId) {
    return {
      runs: [],
      countPendingDescendantRuns: () => 0,
    };
  }

  const snapshot = getSubagentRunsSnapshotForRead(subagentRuns);
  const readIndex = buildSubagentRunReadIndexFromRuns({ runs: snapshot });
  const filtered = Array.from(readIndex.latestRunsByChildSessionKey.values()).filter((entry) =>
    isSubagentRunVisibleToSession(entry, key, agentId, cfg),
  );
  return {
    runs: sortSubagentRuns(filtered),
    countPendingDescendantRuns: (rootSessionKey) =>
      readIndex.countPendingDescendantRuns(rootSessionKey),
  };
}

/** Lists latest child runs controlled by a session key. */
export function listControlledSubagentRuns(
  controllerSessionKey: string,
  controllerAgentId?: string,
  cfg?: OpenClawConfig,
): SubagentRunRecord[] {
  return buildControlledSubagentRunsReadContext(controllerSessionKey, controllerAgentId, cfg).runs;
}

export function ensureSubagentControllerOwnsRun(params: {
  cfg: OpenClawConfig;
  controller: ResolvedSubagentController;
  entry: SubagentRunRecord;
}) {
  const owner = params.entry.controllerSessionKey?.trim() || params.entry.requesterSessionKey;
  const ownerAgentId =
    parseAgentSessionKey(owner)?.agentId ?? resolveRunRequesterAgentId(params.entry, params.cfg);
  const controllerAgentId =
    params.controller.controllerAgentId ??
    parseAgentSessionKey(params.controller.controllerSessionKey)?.agentId;
  if (owner === params.controller.controllerSessionKey && ownerAgentId === controllerAgentId) {
    return undefined;
  }
  return "Subagents can only control runs spawned from their own session.";
}

export function isFinishedSubagentRunForSteer(
  entry: SubagentRunRecord,
  hasPendingDescendants: boolean,
) {
  return (
    Boolean(entry.execution.endedAt) &&
    entry.pauseReason !== "sessions_yield" &&
    !hasPendingDescendants
  );
}

export function getLatestOwnedSubagentRun(
  childSessionKey: string,
  agentId: string | undefined,
  cfg: OpenClawConfig,
): SubagentRunRecord | undefined {
  // Agent-scoped child keys already carry their sole owner; any newer generation fences
  // the old row. Bare per-agent keys need the explicit owner to avoid cross-agent shadowing.
  const ownerFilter = parseAgentSessionKey(childSessionKey) ? undefined : agentId;
  return (
    getLatestLiveSubagentRunByChildSessionKey(
      childSessionKey,
      ownerFilter
        ? (candidate) => resolveRunRequesterAgentId(candidate, cfg) === ownerFilter
        : undefined,
    ) ?? undefined
  );
}

export function isCurrentSubagentRun(entry: SubagentRunRecord, cfg?: OpenClawConfig): boolean {
  if (!cfg) {
    return getLatestLiveSubagentRunByChildSessionKey(entry.childSessionKey) === entry;
  }
  return (
    getLatestOwnedSubagentRun(
      entry.childSessionKey,
      resolveRunRequesterAgentId(entry, cfg),
      cfg,
    ) === entry
  );
}

export function isSameSubagentRunGeneration(
  live: SubagentRunRecord,
  snapshot: SubagentRunRecord,
): boolean {
  return (
    live.childSessionKey === snapshot.childSessionKey &&
    live.runId === snapshot.runId &&
    live.generation === snapshot.generation &&
    live.createdAt === snapshot.createdAt
  );
}
