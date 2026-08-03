import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { AgentsListResult, GatewaySessionRow } from "../../api/types.ts";
import { t } from "../../i18n/index.ts";
import { formatDateMs, formatDateTimeMs, formatDurationCompact } from "../../lib/format.ts";
import {
  findWorkboardSession,
  getWorkboardState,
  workboardMutationsReady,
  type WorkboardCard,
  type WorkboardDependencyState,
  type WorkboardEvent,
  type WorkboardExecutionEngine,
  type WorkboardLifecycle,
  type WorkboardPriority,
  type WorkboardStatus,
  type WorkboardTaskSummary,
  type WorkboardUiState,
} from "../../lib/workboard/index.ts";
import { agentDisplayName, findCardAgent } from "./agent-filter.ts";

export type WorkboardProps = {
  host: object;
  client: GatewayBrowserClient | null;
  connected: boolean;
  canWrite?: boolean;
  canGrant?: boolean;
  canModelOverride?: boolean;
  pluginEnabled: boolean | null;
  pluginEnablementError?: string | null;
  agentsList: AgentsListResult | null;
  defaultAgentId?: string | null;
  sessions: GatewaySessionRow[];
  scopeAgentId?: string | null;
  showAgentFilter?: boolean;
  onOpenSession: (sessionKey: string) => void;
  onBoardFilterChange?: (boardFilter: string) => void;
  onReloadConfig?: () => void;
  onRequestUpdate?: () => void;
};

const eventLabelKeys: Record<WorkboardEvent["kind"], string> = {
  created: "workboard.eventCreated",
  edited: "workboard.eventEdited",
  moved: "workboard.eventMoved",
  linked: "workboard.eventLinked",
  specified: "workboard.eventSpecified",
  decomposed: "workboard.eventDecomposed",
  claimed: "workboard.eventClaimed",
  heartbeat: "workboard.eventHeartbeat",
  execution_updated: "workboard.eventExecutionUpdated",
  attempt_started: "workboard.eventAttemptStarted",
  attempt_updated: "workboard.eventAttemptUpdated",
  comment_added: "workboard.eventCommentAdded",
  link_added: "workboard.eventLinkAdded",
  proof_added: "workboard.eventProofAdded",
  artifact_added: "workboard.eventArtifactAdded",
  attachment_added: "workboard.eventAttachmentAdded",
  diagnostic: "workboard.eventDiagnostic",
  notification: "workboard.eventNotification",
  dispatch: "workboard.eventDispatch",
  orchestration: "workboard.eventOrchestration",
  protocol_violation: "workboard.eventProtocolViolation",
  archived: "workboard.eventArchived",
  unarchived: "workboard.eventUnarchived",
  stale: "workboard.eventStale",
};

type LifecycleCopy = readonly [
  labelKey: string,
  detailKey: string,
  tone: "blocked" | "done" | "idle" | "live",
];

const lifecycleCopy = {
  running: ["workboard.lifecycleRunning", "workboard.lifecycleRunningDetail", "live"],
  succeeded: ["workboard.lifecycleDone", "workboard.lifecycleDoneDetail", "done"],
  failed: ["workboard.lifecycleNeedsReview", "workboard.lifecycleNeedsReviewDetail", "blocked"],
  stale: ["workboard.lifecycleStale", "workboard.lifecycleStaleDetail", "blocked"],
  idle: ["workboard.lifecycleLinked", "workboard.lifecycleIdleDetail", "idle"],
  missing: ["workboard.lifecycleMissing", "workboard.lifecycleMissingDetail", "blocked"],
  unlinked: ["workboard.lifecycleUnlinked", "workboard.lifecycleUnlinkedDetail", "idle"],
} as const satisfies Record<WorkboardLifecycle["state"], LifecycleCopy>;

export const formatStatusLabel = (status: WorkboardStatus) => t(`workboard.status.${status}`);

export const formatPriorityLabel = (priority: WorkboardPriority) =>
  priority.charAt(0).toUpperCase() + priority.slice(1);

export function formatWorkboardDate(value: number | undefined): string {
  return value ? formatDateMs(value, { month: "short", day: "numeric" }, "") : "";
}

export function formatRefreshTime(value: number): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

export function formatUpdatedTime(value: number | undefined): string {
  return value
    ? formatDateTimeMs(
        value,
        { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" },
        "",
      )
    : "";
}

export function formatAge(value: number | undefined): string {
  if (!value) {
    return "";
  }
  return formatDurationCompact(Math.max(0, Date.now() - value), { spaced: true }) ?? "0ms";
}

export function canMutate(props: WorkboardProps): boolean {
  return props.canWrite !== false && workboardMutationsReady(getWorkboardState(props.host));
}

export function formatEventLabel(event: WorkboardEvent): string {
  if (event.kind === "moved" && event.toStatus) {
    return t("workboard.eventMovedTo", { status: formatStatusLabel(event.toStatus) });
  }
  return t(eventLabelKeys[event.kind]);
}

export function matchesFilter(
  card: WorkboardCard,
  options: { query: string; priority: "all" | WorkboardPriority },
): boolean {
  if (options.priority !== "all" && card.priority !== options.priority) {
    return false;
  }
  const query = options.query.trim().toLowerCase();
  if (!query) {
    return true;
  }
  return [
    card.title,
    card.notes,
    card.agentId,
    card.sessionKey,
    card.execution?.engine,
    card.execution?.mode,
    card.execution?.model,
    card.execution?.sessionKey,
    card.metadata?.templateId,
    card.metadata?.automation?.tenant,
    card.metadata?.automation?.idempotencyKey,
    card.metadata?.automation?.workspace?.kind,
    card.metadata?.automation?.workspace?.path,
    card.metadata?.automation?.workspace?.branch,
    ...(card.metadata?.automation?.skills ?? []),
    ...(card.metadata?.automation?.createdCardIds ?? []),
    ...(card.metadata?.comments ?? []).map((comment) => comment.body),
    ...(card.metadata?.links ?? []).flatMap((link) => [link.title, link.url, link.targetCardId]),
    ...(card.metadata?.proof ?? []).flatMap((proof) => [
      proof.label,
      proof.command,
      proof.url,
      proof.note,
    ]),
    ...(card.metadata?.artifacts ?? []).flatMap((artifact) => [
      artifact.label,
      artifact.url,
      artifact.path,
      artifact.mimeType,
    ]),
    ...(card.metadata?.attachments ?? []).flatMap((attachment) => [
      attachment.fileName,
      attachment.mimeType,
      attachment.note,
    ]),
    ...(card.metadata?.workerLogs ?? []).map((log) => log.message),
    card.metadata?.workerProtocol?.state,
    card.metadata?.workerProtocol?.detail,
    card.metadata?.claim?.ownerId,
    ...(card.metadata?.diagnostics ?? []).flatMap((diagnostic) => [
      diagnostic.kind,
      diagnostic.severity,
      diagnostic.title,
      diagnostic.detail,
    ]),
    ...(card.metadata?.notifications ?? []).map((notification) => notification.message),
    ...card.labels,
  ]
    .filter((value): value is string => typeof value === "string")
    .some((value) => value.toLowerCase().includes(query));
}

export function isWorkboardSessionChoice(session: GatewaySessionRow): boolean {
  if (session.archived || session.kind === "global") {
    return false;
  }
  const raw = [session.key, session.label, session.displayName]
    .filter((value): value is string => typeof value === "string")
    .join(":")
    .toLowerCase();
  return !/(^|:)heartbeat(:|$)/.test(raw);
}

export function engineBlockedByRuntime(
  props: WorkboardProps,
  card: WorkboardCard,
  engine: WorkboardExecutionEngine | null,
): string | null {
  if (!engine) {
    return null;
  }
  const agent = findCardAgent(card, props.agentsList);
  const runtime = agent?.agentRuntime?.id?.trim();
  if (!runtime) {
    return null;
  }
  const normalized = runtime.toLowerCase();
  if (normalized === "openclaw" || normalized === "pi") {
    return null;
  }
  return t("workboard.engineDisabledRuntime", {
    agent: agentDisplayName(agent, card.agentId ?? t("workboard.defaultAgent")),
    runtime,
  });
}

export function formatLifecycle(lifecycle: WorkboardLifecycle): {
  label: string;
  detail: string;
  tone: "blocked" | "done" | "idle" | "live";
} {
  const [labelKey, detailKey, tone] = lifecycleCopy[lifecycle.state];
  return { label: t(labelKey), detail: t(detailKey), tone };
}

export function taskDetail(task: WorkboardTaskSummary): string {
  if (task.status === "queued" || task.status === "running") {
    return task.progressSummary ?? task.title ?? task.taskId;
  }
  return task.terminalSummary ?? task.error ?? task.progressSummary ?? task.title ?? task.taskId;
}

export function taskMatchesLifecycle(
  task: WorkboardTaskSummary,
  lifecycle: WorkboardLifecycle,
): boolean {
  switch (task.status) {
    case "queued":
    case "running":
      return lifecycle.state === "running";
    case "completed":
      return lifecycle.state === "succeeded";
    case "failed":
    case "cancelled":
    case "timed_out":
      return lifecycle.state === "failed";
  }
  throw new Error("Unknown workboard task status.");
}

const taskIsActive = (task: WorkboardTaskSummary | undefined) =>
  task?.status === "queued" || task?.status === "running";

function cardHasUnresolvedTaskLink(
  card: WorkboardCard,
  task: WorkboardTaskSummary | undefined,
  missingTaskIds: ReadonlySet<string>,
): boolean {
  return Boolean(card.taskId && !task && !missingTaskIds.has(card.taskId));
}

export function cardHasActiveOrRunningUnresolvedTask(
  card: WorkboardCard,
  task: WorkboardTaskSummary | undefined,
  missingTaskIds: ReadonlySet<string>,
): boolean {
  return (
    taskIsActive(task) ||
    (card.status === "running" && cardHasUnresolvedTaskLink(card, task, missingTaskIds))
  );
}

export function cardHasUnresolvedStartedRun(card: WorkboardCard): boolean {
  const sessionKey = card.sessionKey ?? card.execution?.sessionKey;
  const runId = card.runId ?? card.execution?.runId;
  return card.status === "running" && Boolean(sessionKey && runId);
}

export function cardCanStart(
  state: WorkboardUiState,
  sessions: readonly GatewaySessionRow[],
  card: WorkboardCard,
): boolean {
  const task = state.tasksByCardId.get(card.id);
  const session = findWorkboardSession(card, sessions);
  const taskBlocksStart =
    taskIsActive(task) || cardHasUnresolvedTaskLink(card, task, state.missingTaskIds);
  const linkedSessionKey = card.sessionKey ?? card.execution?.sessionKey;
  return !taskBlocksStart && !cardHasUnresolvedStartedRun(card) && (!linkedSessionKey || !session);
}

export function formatDependencyBlockerTitle(
  dependencies: WorkboardDependencyState,
): string | null {
  if (dependencies.blockedParents.length === 0) {
    return null;
  }
  return t("workboard.dependenciesBlockedTitle", {
    parents: dependencies.blockedParents
      .map((parent) => {
        if (parent.missing) {
          return t("workboard.dependencyMissing", { parent: parent.title });
        }
        const status = parent.status
          ? formatStatusLabel(parent.status)
          : t("workboard.unknownStatus");
        return `${parent.title} (${status})`;
      })
      .join(", "),
  });
}
