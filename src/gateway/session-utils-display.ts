import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  countActiveDescendantRuns,
  getSessionDisplaySubagentRunByChildSessionKey,
  getSubagentSessionRuntimeMs,
  getSubagentSessionStartedAt,
  isSubagentRunLive,
  isSubagentRunQueued,
  resolveSubagentSessionStatus,
} from "../agents/subagents/registry/subagent-registry-read.js";
import {
  buildGroupDisplayName,
  buildGroupDisplayTitle,
  resolveSessionGoalDisplayState,
  type SessionEntry,
} from "../config/sessions.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { classifySessionKind } from "../sessions/classify-session-kind.js";
import { sessionDeliveryChannel, sessionDeliveryOrigin } from "../utils/delivery-context.shared.js";
import type {
  SessionListActiveRunProjector,
  SessionListRowContext,
} from "./session-utils-contracts.js";
import { isGroupOrChannelDisplaySession, parseGroupKey } from "./session-utils-store.js";
import type { GatewaySessionRow } from "./session-utils.types.js";

export function resolveGatewaySessionDisplayName(key: string, entry?: SessionEntry) {
  const parsed = parseGroupKey(key);
  const parsedAgent = parseAgentSessionKey(key);
  const channel = sessionDeliveryChannel(entry) ?? parsed?.channel;
  const subject = entry?.subject;
  const groupChannel = entry?.groupChannel;
  const space = entry?.space;
  const id = parsed?.id;
  const originLabel = sessionDeliveryOrigin(entry)?.label;
  const isDashboardSession = parsedAgent?.rest.startsWith("dashboard:") === true;
  const isGroupSession = isGroupOrChannelDisplaySession(entry, parsed);
  // A user-assigned label is an explicit rename; it must win over stored
  // channel-derived display names or renames silently vanish on refresh.
  // Group sessions prefer the human chat title (subject/#channel) over the
  // stored compact token displayName (e.g. "slack:g-general").
  const displayName =
    entry?.label ??
    (isGroupSession ? buildGroupDisplayTitle({ subject, groupChannel, space }) : undefined) ??
    entry?.displayName ??
    (isGroupSession && channel
      ? buildGroupDisplayName({
          provider: channel,
          subject,
          groupChannel,
          space,
          id,
          key,
        })
      : undefined) ??
    // Dashboard origin labels identify the authenticated sender. Using them as
    // titles leaks account names into the sidebar while the generated title is pending.
    (isDashboardSession ? undefined : originLabel);
  return displayName;
}

export function resolveGatewaySessionKind(key: string, entry?: SessionEntry) {
  const sessionKind = classifySessionKind(key, entry);
  // The older Gateway wire kind folds cron/spawn-child into direct.
  const gatewayKind =
    sessionKind === "cron" || sessionKind === "spawn-child" ? "direct" : sessionKind;
  return gatewayKind;
}

export function projectGatewaySessionRunState(params: {
  key: string;
  entry?: SessionEntry;
  now: number;
  rowContext?: SessionListRowContext;
}) {
  const { key, entry, now, rowContext } = params;
  const subagentRun = rowContext
    ? rowContext.subagentRuns.getDisplaySubagentRun(key)
    : getSessionDisplaySubagentRunByChildSessionKey(key);
  const subagentOwner =
    normalizeOptionalString(subagentRun?.controllerSessionKey) ||
    normalizeOptionalString(subagentRun?.requesterSessionKey);
  const liveSubagentRunActive = isSubagentRunLive(subagentRun) || isSubagentRunQueued(subagentRun);
  const hasActiveSubagentRun =
    liveSubagentRunActive ||
    (rowContext?.subagentRuns.countActiveDescendantRuns(key) ?? countActiveDescendantRuns(key)) > 0;
  const persistedSessionStatus = entry?.status;
  const persistedSessionEndedAt = entry?.endedAt;
  const persistedSessionStartedAt = entry?.startedAt;
  const persistedSessionRuntimeMs = entry?.runtimeMs;
  const subagentRunState = subagentRun
    ? liveSubagentRunActive
      ? "active"
      : typeof subagentRun.execution.endedAt === "number" ||
          persistedSessionStatus === "done" ||
          persistedSessionStatus === "failed" ||
          persistedSessionStatus === "killed" ||
          persistedSessionStatus === "timeout" ||
          typeof persistedSessionEndedAt === "number"
        ? "historical"
        : "interrupted"
    : undefined;
  const subagentStatus = subagentRun
    ? liveSubagentRunActive
      ? resolveSubagentSessionStatus(subagentRun)
      : persistedSessionStatus === "running"
        ? undefined
        : (persistedSessionStatus ??
          (typeof subagentRun.execution.endedAt === "number"
            ? resolveSubagentSessionStatus(subagentRun)
            : undefined))
    : undefined;
  const subagentStartedAt = subagentRun
    ? liveSubagentRunActive
      ? getSubagentSessionStartedAt(subagentRun)
      : (persistedSessionStartedAt ?? getSubagentSessionStartedAt(subagentRun))
    : undefined;
  const subagentEndedAt = subagentRun
    ? liveSubagentRunActive
      ? subagentRun.execution.endedAt
      : (persistedSessionEndedAt ?? subagentRun.execution.endedAt)
    : undefined;
  const subagentRuntimeMs = subagentRun
    ? liveSubagentRunActive
      ? getSubagentSessionRuntimeMs(subagentRun, now)
      : (persistedSessionRuntimeMs ??
        (typeof subagentRun.execution.endedAt === "number"
          ? getSubagentSessionRuntimeMs(subagentRun, now)
          : undefined))
    : undefined;
  const fields: Pick<
    GatewaySessionRow,
    "status" | "subagentRunState" | "hasActiveSubagentRun" | "startedAt" | "endedAt" | "runtimeMs"
  > = {
    status: subagentRun ? subagentStatus : entry?.status,
    subagentRunState,
    hasActiveSubagentRun: subagentRun || hasActiveSubagentRun ? hasActiveSubagentRun : undefined,
    startedAt: subagentRun ? subagentStartedAt : entry?.startedAt,
    endedAt: subagentRun ? subagentEndedAt : entry?.endedAt,
    runtimeMs: subagentRun ? subagentRuntimeMs : entry?.runtimeMs,
  };
  return { subagentRun, subagentOwner, fields };
}

export function resolveGatewaySessionGoal(
  entry: SessionEntry | undefined,
  now: number,
  usage:
    | Pick<SessionEntry, "totalTokens" | "totalTokensFresh" | "totalTokensVersion">
    | undefined = entry,
) {
  // Listing is read-only; only goal commands may adopt and persist a fresh baseline.
  return entry?.goal
    ? resolveSessionGoalDisplayState({ ...usage, goal: entry.goal }, now, {
        adoptFreshBaseline: false,
      })
    : undefined;
}

export function projectGatewaySessionActiveRun(
  active: ReturnType<SessionListActiveRunProjector> | undefined,
  status: GatewaySessionRow["status"],
): Pick<GatewaySessionRow, "status" | "hasActiveRun"> {
  return {
    hasActiveRun: active?.active,
    status: active?.active ? (active.status ?? "running") : status,
  };
}
