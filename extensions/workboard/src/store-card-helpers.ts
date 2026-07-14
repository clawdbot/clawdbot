import { randomUUID } from "node:crypto";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import {
  BLOCKED_TOO_LONG_MS,
  MAX_CARD_ATTEMPTS,
  MAX_CARD_EVENTS,
  READY_STRANDED_MS,
  RUNNING_HEARTBEAT_STALE_MS,
} from "./store-constants.js";
import type { WorkboardMutationScope } from "./store-inputs.js";
import {
  metadataIsEmpty,
  normalizeEvents,
  normalizeOptionalString,
  normalizeTimestamp,
  removeUndefinedMetadataFields,
} from "./store-normalizers.js";
import {
  WORKBOARD_STATUSES,
  type WorkboardAttemptStatus,
  type WorkboardCard,
  type WorkboardDiagnostic,
  type WorkboardDiagnosticAction,
  type WorkboardDiagnosticKind,
  type WorkboardDiagnosticSeverity,
  type WorkboardEvent,
  type WorkboardExecution,
  type WorkboardMetadata,
  type WorkboardNotification,
  type WorkboardRunAttempt,
  type WorkboardStatus,
} from "./types.js";

export function compareCards(left: WorkboardCard, right: WorkboardCard): number {
  if (left.status !== right.status) {
    return WORKBOARD_STATUSES.indexOf(left.status) - WORKBOARD_STATUSES.indexOf(right.status);
  }
  if (left.position !== right.position) {
    return left.position - right.position;
  }
  return left.createdAt - right.createdAt;
}

export function cardSessionKey(card: WorkboardCard): string | undefined {
  return card.sessionKey ?? card.execution?.sessionKey;
}

export function cardRunId(card: WorkboardCard): string | undefined {
  return card.runId ?? card.execution?.runId;
}

function executionAttemptStatus(execution: WorkboardExecution): WorkboardAttemptStatus {
  if (execution.status === "running") {
    return "running";
  }
  if (execution.status === "blocked") {
    return "blocked";
  }
  if (execution.status === "done" || execution.status === "review") {
    return "succeeded";
  }
  return "stopped";
}

export function syncExecutionAttemptMetadata(
  metadata: WorkboardMetadata,
  execution: WorkboardExecution | undefined,
  now: number,
): WorkboardMetadata {
  if (!execution) {
    return metadata;
  }
  const attemptStatus = executionAttemptStatus(execution);
  const attempts = [...(metadata.attempts ?? [])];
  const key = execution.runId ?? execution.sessionKey ?? execution.id;
  const existingIndex = attempts.findIndex(
    (attempt) =>
      (execution.runId && attempt.runId === execution.runId) ||
      (!execution.runId && attempt.id === key),
  );
  const existingAttempt = existingIndex >= 0 ? attempts[existingIndex] : undefined;
  const nextAttempt: WorkboardRunAttempt = {
    id: existingAttempt?.id ?? key,
    status: attemptStatus,
    startedAt: existingAttempt?.startedAt ?? execution.startedAt,
    engine: execution.engine,
    mode: execution.mode,
    model: execution.model,
    ...(execution.sessionKey ? { sessionKey: execution.sessionKey } : {}),
    ...(execution.runId ? { runId: execution.runId } : {}),
    ...(attemptStatus !== "running" && { endedAt: execution.updatedAt || now }),
    ...(attemptStatus !== "succeeded" && existingAttempt?.error
      ? { error: existingAttempt.error }
      : {}),
  };
  if (existingIndex >= 0) {
    attempts[existingIndex] = nextAttempt;
  } else {
    attempts.push(nextAttempt);
  }
  const previousFailed =
    existingAttempt?.status === "blocked" || existingAttempt?.status === "failed";
  const attemptFailed = attemptStatus === "blocked" || attemptStatus === "failed";
  const failureCount = attemptFailed
    ? previousFailed
      ? metadata.failureCount
      : (metadata.failureCount ?? 0) + 1
    : attemptStatus === "succeeded"
      ? 0
      : metadata.failureCount;
  return removeUndefinedMetadataFields({
    ...metadata,
    attempts: attempts.slice(-MAX_CARD_ATTEMPTS),
    failureCount,
  });
}

export function appendEvent(
  card: WorkboardCard,
  event: Omit<WorkboardEvent, "id" | "at">,
  at = Date.now(),
): WorkboardEvent[] {
  return [
    ...normalizeEvents(card.events),
    {
      id: randomUUID(),
      at,
      ...event,
    },
  ].slice(-MAX_CARD_EVENTS);
}

function latestMetadataIdChanged(
  existing: readonly { id: string }[] | undefined,
  next: readonly { id: string }[] | undefined,
): boolean {
  const latestId = next?.at(-1)?.id;
  return Boolean(latestId && latestId !== existing?.at(-1)?.id);
}

export function lifecycleStatusSourceUpdatedAtFromPatch(metadata: unknown): number | undefined {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return undefined;
  }
  if (!Object.hasOwn(metadata, "lifecycleStatusSourceUpdatedAt")) {
    return undefined;
  }
  const sourceUpdatedAt = normalizeTimestamp(
    (metadata as Record<string, unknown>).lifecycleStatusSourceUpdatedAt,
    0,
  );
  return sourceUpdatedAt;
}

function latestStatusTransitionAt(card: WorkboardCard): number | undefined {
  for (let index = (card.events?.length ?? 0) - 1; index >= 0; index -= 1) {
    const event = card.events?.[index];
    if (
      (event?.kind === "moved" || event?.kind === "created") &&
      ((event.kind === "created" && card.status !== "todo") ||
        (event.kind === "moved" && event.fromStatus !== event.toStatus)) &&
      event.toStatus === card.status &&
      typeof event.at === "number" &&
      Number.isFinite(event.at)
    ) {
      return event.at;
    }
  }
  return undefined;
}

export function shouldSkipPersistedLifecycleStatusUpdate(
  existing: WorkboardCard,
  sourceUpdatedAt: number,
): boolean {
  const lifecycleStatusSourceUpdatedAt = existing.metadata?.lifecycleStatusSourceUpdatedAt;
  if (lifecycleStatusSourceUpdatedAt !== undefined) {
    return sourceUpdatedAt < lifecycleStatusSourceUpdatedAt;
  }
  const statusTransitionAt = latestStatusTransitionAt(existing);
  return statusTransitionAt !== undefined && sourceUpdatedAt < statusTransitionAt;
}

export function updateEvent(
  existing: WorkboardCard,
  next: WorkboardCard,
): Omit<WorkboardEvent, "id" | "at"> {
  if (
    existing.metadata?.workerProtocol?.state !== next.metadata?.workerProtocol?.state &&
    next.metadata?.workerProtocol?.state === "violated"
  ) {
    return { kind: "protocol_violation" };
  }
  if (existing.status !== next.status || existing.position !== next.position) {
    return {
      kind: "moved",
      fromStatus: existing.status,
      toStatus: next.status,
    };
  }
  if (cardSessionKey(existing) !== cardSessionKey(next)) {
    return {
      kind: "linked",
      ...(cardSessionKey(next) ? { sessionKey: cardSessionKey(next) } : {}),
    };
  }
  if (existing.metadata?.claim?.token !== next.metadata?.claim?.token) {
    return { kind: "claimed" };
  }
  if (existing.metadata?.claim?.lastHeartbeatAt !== next.metadata?.claim?.lastHeartbeatAt) {
    return { kind: "heartbeat" };
  }
  if (
    existing.execution?.status !== next.execution?.status ||
    existing.execution?.engine !== next.execution?.engine ||
    cardRunId(existing) !== cardRunId(next)
  ) {
    const existingAttempts = existing.metadata?.attempts ?? [];
    const nextAttempts = next.metadata?.attempts ?? [];
    const latestAttempt = nextAttempts.at(-1);
    if (nextAttempts.length > existingAttempts.length) {
      return {
        kind: "attempt_started",
        ...(latestAttempt?.sessionKey ? { sessionKey: latestAttempt.sessionKey } : {}),
        ...(latestAttempt?.runId ? { runId: latestAttempt.runId } : {}),
      };
    }
    const previousAttempt = latestAttempt
      ? existingAttempts.find((attempt) => attempt.id === latestAttempt.id)
      : undefined;
    if (latestAttempt && previousAttempt?.status !== latestAttempt.status) {
      return {
        kind: "attempt_updated",
        ...(latestAttempt.sessionKey ? { sessionKey: latestAttempt.sessionKey } : {}),
        ...(latestAttempt.runId ? { runId: latestAttempt.runId } : {}),
      };
    }
    return {
      kind: "execution_updated",
      ...(cardSessionKey(next) ? { sessionKey: cardSessionKey(next) } : {}),
      ...(cardRunId(next) ? { runId: cardRunId(next) } : {}),
    };
  }
  if (
    (existing.metadata?.comments?.length ?? 0) !== (next.metadata?.comments?.length ?? 0) ||
    latestMetadataIdChanged(existing.metadata?.comments, next.metadata?.comments)
  ) {
    return { kind: "comment_added" };
  }
  if (
    (existing.metadata?.links?.length ?? 0) !== (next.metadata?.links?.length ?? 0) ||
    latestMetadataIdChanged(existing.metadata?.links, next.metadata?.links)
  ) {
    return { kind: "link_added" };
  }
  if (
    (existing.metadata?.proof?.length ?? 0) !== (next.metadata?.proof?.length ?? 0) ||
    latestMetadataIdChanged(existing.metadata?.proof, next.metadata?.proof)
  ) {
    return { kind: "proof_added" };
  }
  if (
    (existing.metadata?.artifacts?.length ?? 0) !== (next.metadata?.artifacts?.length ?? 0) ||
    latestMetadataIdChanged(existing.metadata?.artifacts, next.metadata?.artifacts)
  ) {
    return { kind: "artifact_added" };
  }
  if (
    (existing.metadata?.attachments?.length ?? 0) !== (next.metadata?.attachments?.length ?? 0) ||
    latestMetadataIdChanged(existing.metadata?.attachments, next.metadata?.attachments)
  ) {
    return (next.metadata?.attachments?.length ?? 0) > (existing.metadata?.attachments?.length ?? 0)
      ? { kind: "attachment_added" }
      : { kind: "edited" };
  }
  if (existing.metadata?.workerProtocol?.state !== next.metadata?.workerProtocol?.state) {
    return { kind: "orchestration" };
  }
  if (
    (existing.metadata?.workerLogs?.length ?? 0) !== (next.metadata?.workerLogs?.length ?? 0) ||
    latestMetadataIdChanged(existing.metadata?.workerLogs, next.metadata?.workerLogs)
  ) {
    return { kind: "orchestration" };
  }
  if ((existing.metadata?.diagnostics?.length ?? 0) !== (next.metadata?.diagnostics?.length ?? 0)) {
    return { kind: "diagnostic" };
  }
  if (
    (existing.metadata?.notifications?.length ?? 0) !==
      (next.metadata?.notifications?.length ?? 0) ||
    latestMetadataIdChanged(existing.metadata?.notifications, next.metadata?.notifications)
  ) {
    return { kind: "notification" };
  }
  if (
    existing.metadata?.automation?.dispatchCount !== next.metadata?.automation?.dispatchCount ||
    existing.metadata?.automation?.lastDispatchAt !== next.metadata?.automation?.lastDispatchAt
  ) {
    return { kind: "dispatch" };
  }
  if (!existing.metadata?.archivedAt && next.metadata?.archivedAt) {
    return { kind: "archived" };
  }
  if (existing.metadata?.archivedAt && !next.metadata?.archivedAt) {
    return { kind: "unarchived" };
  }
  if (!existing.metadata?.stale && next.metadata?.stale) {
    return { kind: "stale" };
  }
  return { kind: "edited" };
}

export function removeUndefinedCardFields(card: WorkboardCard): WorkboardCard {
  const next = { ...card };
  for (const key of [
    "notes",
    "agentId",
    "sessionKey",
    "runId",
    "taskId",
    "sourceUrl",
    "execution",
    "startedAt",
    "completedAt",
    "metadata",
  ] as const) {
    if (next[key] === undefined) {
      delete next[key];
    }
  }
  if (metadataIsEmpty(next.metadata)) {
    delete next.metadata;
  }
  return next;
}

export function assertCanMutateClaimedCard(
  card: WorkboardCard,
  scope: WorkboardMutationScope | undefined,
) {
  if (!scope) {
    return;
  }
  const claim = card.metadata?.claim;
  if (!claim) {
    return;
  }
  const ownerId = normalizeOptionalString(scope.ownerId);
  const token = normalizeOptionalString(scope.token);
  if (claim.ownerId === ownerId || (token && claim.token === token)) {
    return;
  }
  throw new Error(`card is claimed by ${claim.ownerId}.`);
}

export function retryBudgetExhausted(card: WorkboardCard): boolean {
  const maxRetries = card.metadata?.automation?.maxRetries;
  return Boolean(maxRetries && (card.metadata?.failureCount ?? 0) > maxRetries);
}

function diagnostic(
  params: {
    kind: WorkboardDiagnosticKind;
    severity: WorkboardDiagnosticSeverity;
    title: string;
    detail: string;
    actions: WorkboardDiagnosticAction[];
  },
  now: number,
): WorkboardDiagnostic {
  return {
    ...params,
    firstSeenAt: now,
    lastSeenAt: now,
    count: 1,
  };
}

export function mergeDiagnostics(
  previous: readonly WorkboardDiagnostic[] | undefined,
  next: WorkboardDiagnostic[],
): WorkboardDiagnostic[] {
  const byKind = new Map(previous?.map((entry) => [entry.kind, entry]));
  return next.map((entry) => {
    const prior = byKind.get(entry.kind);
    return prior
      ? {
          ...entry,
          firstSeenAt: prior.firstSeenAt,
          count: prior.count + 1,
        }
      : entry;
  });
}

export function computeCardDiagnostics(card: WorkboardCard, now: number): WorkboardDiagnostic[] {
  const diagnostics: WorkboardDiagnostic[] = [];
  const claim = card.metadata?.claim;
  const lastHeartbeatAt = claim?.lastHeartbeatAt ?? card.execution?.updatedAt ?? card.updatedAt;
  if (
    (card.status === "todo" || card.status === "backlog" || card.status === "ready") &&
    card.agentId &&
    now - card.updatedAt > READY_STRANDED_MS
  ) {
    diagnostics.push(
      diagnostic(
        {
          kind: "stranded_ready",
          severity: "warning",
          title: "Assigned card is waiting",
          detail: "The card has an assigned agent but has not been claimed recently.",
          actions: [{ kind: "claim", label: "Claim card" }],
        },
        now,
      ),
    );
  }
  if (card.status === "running" && now - lastHeartbeatAt > RUNNING_HEARTBEAT_STALE_MS) {
    diagnostics.push(
      diagnostic(
        {
          kind: "running_without_heartbeat",
          severity: "error",
          title: "Running card has no recent heartbeat",
          detail: "The linked run or claim has not reported recent activity.",
          actions: [
            { kind: "open_session", label: "Open session" },
            { kind: "reassign", label: "Reassign card" },
          ],
        },
        now,
      ),
    );
  }
  if (card.status === "blocked" && now - card.updatedAt > BLOCKED_TOO_LONG_MS) {
    diagnostics.push(
      diagnostic(
        {
          kind: "blocked_too_long",
          severity: "warning",
          title: "Blocked card needs attention",
          detail: "The card has been blocked for more than a day.",
          actions: [{ kind: "unblock", label: "Move to todo" }],
        },
        now,
      ),
    );
  }
  if ((card.metadata?.failureCount ?? 0) >= 2) {
    diagnostics.push(
      diagnostic(
        {
          kind: "repeated_failures",
          severity: "error",
          title: "Repeated run failures",
          detail: "Multiple attempts failed or blocked on this card.",
          actions: [{ kind: "reassign", label: "Reassign card" }],
        },
        now,
      ),
    );
  }
  if (
    card.status === "done" &&
    !(
      card.metadata?.proof?.length ||
      card.metadata?.artifacts?.length ||
      card.metadata?.attachments?.length
    )
  ) {
    diagnostics.push(
      diagnostic(
        {
          kind: "missing_proof",
          severity: "warning",
          title: "Done card has no proof",
          detail: "The card is marked done without proof or an attached artifact.",
          actions: [{ kind: "add_proof", label: "Add proof" }],
        },
        now,
      ),
    );
  }
  if (card.sessionKey && !card.execution && card.status === "running") {
    diagnostics.push(
      diagnostic(
        {
          kind: "orphaned_session",
          severity: "warning",
          title: "Running card has only a loose session link",
          detail: "The card is running but has no execution record for lifecycle handoff.",
          actions: [{ kind: "open_session", label: "Open session" }],
        },
        now,
      ),
    );
  }
  return diagnostics;
}

export function capText(value: string | undefined, max: number): string | undefined {
  if (!value) {
    return undefined;
  }
  return value.length <= max ? value : `${truncateUtf16Safe(value, Math.max(0, max - 1))}…`;
}

export function cardBoardId(card: WorkboardCard): string {
  return card.metadata?.automation?.boardId ?? "default";
}

function cardResultSummary(card: WorkboardCard): string | undefined {
  return (
    card.metadata?.automation?.summary ??
    card.metadata?.comments?.findLast((comment) => comment.body.trim())?.body ??
    card.metadata?.proof?.findLast((proof) => proof.note?.trim())?.note
  );
}

export function buildWorkerContext(
  card: WorkboardCard,
  cards: readonly WorkboardCard[] = [],
): string {
  const lines = [
    `# Workboard card ${card.id}`,
    `Title: ${card.title}`,
    `Status: ${card.status}`,
    `Priority: ${card.priority}`,
    `Board: ${cardBoardId(card)}`,
    `Agent: ${card.agentId ?? "(default)"}`,
  ];
  if (card.notes) {
    lines.push("", "## Notes", capText(card.notes, 4000) ?? "");
  }
  const attempts = card.metadata?.attempts?.slice(-8) ?? [];
  if (attempts.length) {
    lines.push("", "## Recent attempts");
    for (const attempt of attempts) {
      lines.push(
        `- ${attempt.status} ${attempt.model ?? ""} ${attempt.error ? `error=${capText(attempt.error, 240)}` : ""}`.trim(),
      );
    }
  }
  const comments = card.metadata?.comments?.slice(-12) ?? [];
  if (comments.length) {
    lines.push("", "## Recent comments");
    for (const comment of comments) {
      lines.push(`- ${capText(comment.body, 400)}`);
    }
  }
  const proof = card.metadata?.proof?.slice(-8) ?? [];
  if (proof.length) {
    lines.push("", "## Proof");
    for (const entry of proof) {
      lines.push(
        `- ${entry.status}: ${capText(entry.label ?? entry.command ?? entry.url ?? entry.note, 400)}`,
      );
    }
  }
  const artifacts = card.metadata?.artifacts?.slice(-8) ?? [];
  if (artifacts.length) {
    lines.push("", "## Artifacts");
    for (const artifact of artifacts) {
      lines.push(`- ${capText(artifact.label ?? artifact.url ?? artifact.path, 400)}`);
    }
  }
  const attachments = card.metadata?.attachments?.slice(-8) ?? [];
  if (attachments.length) {
    lines.push("", "## Attachments");
    for (const attachment of attachments) {
      const detail = [
        attachment.fileName,
        `${attachment.byteSize} bytes`,
        attachment.mimeType,
        attachment.note,
      ]
        .filter(Boolean)
        .join(" · ");
      lines.push(`- ${capText(detail, 500)}`);
    }
  }
  if (card.metadata?.workerProtocol) {
    const protocol = card.metadata.workerProtocol;
    lines.push("", "## Worker protocol");
    lines.push(`${protocol.state}: ${capText(protocol.detail, 500) ?? "no detail"}`);
  }
  const workerLogs = card.metadata?.workerLogs?.slice(-8) ?? [];
  if (workerLogs.length) {
    lines.push("", "## Worker logs");
    for (const log of workerLogs) {
      lines.push(`- ${log.level}: ${capText(log.message, 500)}`);
    }
  }
  const links = card.metadata?.links?.slice(-8) ?? [];
  if (links.length) {
    lines.push("", "## Links");
    for (const link of links) {
      lines.push(`- ${link.type}: ${link.title ?? link.url ?? link.targetCardId ?? ""}`);
    }
  }
  const cardsById = new Map(cards.map((entry) => [entry.id, entry]));
  const parentResults = cardParentIds(card)
    .map((parentId) => cardsById.get(parentId))
    .filter((parent): parent is WorkboardCard => parent !== undefined && parent.status === "done")
    .slice(-6);
  if (parentResults.length) {
    lines.push("", "## Parent results");
    for (const parent of parentResults) {
      lines.push(
        `- ${parent.id} ${parent.title}: ${capText(cardResultSummary(parent), 500) ?? "done"}`,
      );
    }
  }
  const recentAgentWork =
    card.agentId && cards.length
      ? cards
          .filter(
            (entry) =>
              entry.id !== card.id &&
              cardBoardId(entry) === cardBoardId(card) &&
              entry.agentId === card.agentId &&
              entry.status === "done",
          )
          .toSorted((a, b) => b.updatedAt - a.updatedAt)
          .slice(0, 5)
      : [];
  if (recentAgentWork.length) {
    lines.push("", `## Recent done work by ${card.agentId}`);
    for (const entry of recentAgentWork) {
      lines.push(
        `- ${entry.id} ${entry.title}: ${capText(cardResultSummary(entry), 300) ?? "done"}`,
      );
    }
  }
  const automation = card.metadata?.automation;
  if (automation) {
    lines.push("", "## Automation");
    if (automation.tenant) {
      lines.push(`Tenant: ${automation.tenant}`);
    }
    if (automation.boardId) {
      lines.push(`Board: ${automation.boardId}`);
    }
    if (automation.skills?.length) {
      lines.push(`Skills: ${automation.skills.join(", ")}`);
    }
    if (automation.workspace) {
      lines.push(
        `Workspace: ${automation.workspace.kind}${automation.workspace.path ? ` ${automation.workspace.path}` : ""}`,
      );
    }
    if (automation.summary) {
      lines.push(`Summary: ${capText(automation.summary, 400)}`);
    }
  }
  const diagnostics = computeCardDiagnostics(card, Date.now());
  if (diagnostics.length) {
    lines.push("", "## Active diagnostics");
    for (const entry of diagnostics) {
      lines.push(`- ${entry.severity}: ${entry.title}`);
    }
  }
  return lines.join("\n");
}

export function cardParentIds(card: WorkboardCard): string[] {
  return (card.metadata?.links ?? [])
    .filter((link) => link.type === "parent" && link.targetCardId)
    .map((link) => link.targetCardId!)
    .filter((id, index, ids) => ids.indexOf(id) === index);
}

export function cardChildIds(card: WorkboardCard): string[] {
  return (card.metadata?.links ?? [])
    .filter((link) => link.type === "child" && link.targetCardId)
    .map((link) => link.targetCardId!)
    .filter((id, index, ids) => ids.indexOf(id) === index);
}

export function latestRunningAttempt(card: WorkboardCard): WorkboardRunAttempt | undefined {
  return card.metadata?.attempts?.findLast((attempt) => attempt.status === "running");
}

export function isDependencyPromotableStatus(status: WorkboardStatus): boolean {
  return (
    status === "backlog" ||
    status === "triage" ||
    status === "todo" ||
    status === "scheduled" ||
    status === "ready"
  );
}

export function isActiveDependencyTarget(
  card: WorkboardCard,
  options: { allowStatusOnly?: boolean } = {},
): boolean {
  return (
    Boolean(card.metadata?.claim) ||
    card.execution?.status === "running" ||
    Boolean(latestRunningAttempt(card)) ||
    (!options.allowStatusOnly && (card.status === "running" || card.status === "review"))
  );
}

export function closeRunningAttempts(
  attempts: WorkboardRunAttempt[] | undefined,
  now: number,
  status: WorkboardAttemptStatus,
  reason?: string,
): WorkboardRunAttempt[] | undefined {
  if (!attempts?.some((attempt) => attempt.status === "running")) {
    return attempts;
  }
  return attempts.map((attempt) =>
    attempt.status === "running"
      ? { ...attempt, status, endedAt: now, ...(reason ? { error: reason } : {}) }
      : attempt,
  );
}

export function notificationSequence(event: WorkboardNotification): number | undefined {
  return typeof event.sequence === "number" && Number.isFinite(event.sequence)
    ? Math.trunc(event.sequence)
    : undefined;
}

export function compareNotifications(a: WorkboardNotification, b: WorkboardNotification): number {
  if (a.createdAt !== b.createdAt) {
    return a.createdAt - b.createdAt;
  }
  const aSequence = notificationSequence(a);
  const bSequence = notificationSequence(b);
  if (aSequence !== undefined && bSequence !== undefined) {
    return aSequence - bSequence || a.id.localeCompare(b.id);
  }
  if (aSequence !== undefined) {
    return -1;
  }
  if (bSequence !== undefined) {
    return 1;
  }
  return a.id.localeCompare(b.id);
}
