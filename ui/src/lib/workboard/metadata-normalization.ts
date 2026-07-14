import { isRecord } from "./normalization-utils.ts";
import {
  WORKBOARD_ATTEMPT_STATUSES,
  WORKBOARD_DIAGNOSTIC_SEVERITIES,
  WORKBOARD_EVENT_KINDS,
  WORKBOARD_EXECUTION_ENGINES,
  WORKBOARD_EXECUTION_MODES,
  WORKBOARD_EXECUTION_STATUSES,
  WORKBOARD_LINK_TYPES,
  WORKBOARD_PROOF_STATUSES,
  WORKBOARD_STATUSES,
  WORKBOARD_TEMPLATE_IDS,
  type WorkboardArtifact,
  type WorkboardAttachment,
  type WorkboardAttemptStatus,
  type WorkboardAutomation,
  type WorkboardComment,
  type WorkboardDiagnostic,
  type WorkboardDiagnosticSeverity,
  type WorkboardEvent,
  type WorkboardEventKind,
  type WorkboardExecution,
  type WorkboardExecutionEngine,
  type WorkboardExecutionMode,
  type WorkboardExecutionStatus,
  type WorkboardLink,
  type WorkboardLinkType,
  type WorkboardMetadata,
  type WorkboardNotification,
  type WorkboardProof,
  type WorkboardProofStatus,
  type WorkboardRunAttempt,
  type WorkboardStatus,
  type WorkboardTemplateId,
  type WorkboardWorkerLog,
  type WorkboardWorkerProtocol,
  type WorkboardWorkspace,
} from "./types.ts";

export function normalizeExecution(value: unknown): WorkboardExecution | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const id = typeof value.id === "string" && value.id.trim() ? value.id.trim() : "";
  const engine = WORKBOARD_EXECUTION_ENGINES.includes(value.engine as WorkboardExecutionEngine)
    ? (value.engine as WorkboardExecutionEngine)
    : null;
  const mode = WORKBOARD_EXECUTION_MODES.includes(value.mode as WorkboardExecutionMode)
    ? (value.mode as WorkboardExecutionMode)
    : null;
  const status = WORKBOARD_EXECUTION_STATUSES.includes(value.status as WorkboardExecutionStatus)
    ? (value.status as WorkboardExecutionStatus)
    : "idle";
  const model = typeof value.model === "string" && value.model.trim() ? value.model.trim() : "";
  const startedAt = typeof value.startedAt === "number" ? value.startedAt : 0;
  const updatedAt = typeof value.updatedAt === "number" ? value.updatedAt : startedAt;
  if (!id || !engine || !mode || !model || !startedAt) {
    return undefined;
  }
  return {
    id,
    kind: "agent-session",
    engine,
    mode,
    status,
    model,
    startedAt,
    updatedAt,
    ...(typeof value.sessionKey === "string" ? { sessionKey: value.sessionKey } : {}),
    ...(typeof value.runId === "string" ? { runId: value.runId } : {}),
  };
}

function normalizeEvent(value: unknown): WorkboardEvent | null {
  if (!isRecord(value)) {
    return null;
  }
  const id = typeof value.id === "string" && value.id.trim() ? value.id.trim() : "";
  const kind = WORKBOARD_EVENT_KINDS.includes(value.kind as WorkboardEventKind)
    ? (value.kind as WorkboardEventKind)
    : null;
  const at = typeof value.at === "number" && Number.isFinite(value.at) ? value.at : 0;
  if (!id || !kind || !at) {
    return null;
  }
  const fromStatus = WORKBOARD_STATUSES.includes(value.fromStatus as WorkboardStatus)
    ? (value.fromStatus as WorkboardStatus)
    : undefined;
  const toStatus = WORKBOARD_STATUSES.includes(value.toStatus as WorkboardStatus)
    ? (value.toStatus as WorkboardStatus)
    : undefined;
  return {
    id,
    kind,
    at,
    ...(fromStatus ? { fromStatus } : {}),
    ...(toStatus ? { toStatus } : {}),
    ...(typeof value.sessionKey === "string" ? { sessionKey: value.sessionKey } : {}),
    ...(typeof value.runId === "string" ? { runId: value.runId } : {}),
  };
}

export function normalizeEvents(value: unknown): WorkboardEvent[] {
  return Array.isArray(value)
    ? value.map(normalizeEvent).filter((event): event is WorkboardEvent => event !== null)
    : [];
}

function normalizeStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "")
    : [];
}

function normalizeWorkerProtocolState(
  value: unknown,
): WorkboardWorkerProtocol["state"] | undefined {
  return value === "idle" ||
    value === "running" ||
    value === "completed" ||
    value === "blocked" ||
    value === "violated"
    ? value
    : undefined;
}

function normalizeAutomation(value: unknown): WorkboardAutomation | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const workspace = isRecord(value.workspace)
    ? {
        kind:
          value.workspace.kind === "scratch" ||
          value.workspace.kind === "dir" ||
          value.workspace.kind === "worktree"
            ? value.workspace.kind
            : undefined,
        ...(typeof value.workspace.path === "string" ? { path: value.workspace.path } : {}),
        ...(typeof value.workspace.branch === "string" ? { branch: value.workspace.branch } : {}),
      }
    : undefined;
  const automation: WorkboardAutomation = {
    ...(typeof value.tenant === "string" ? { tenant: value.tenant } : {}),
    ...(typeof value.boardId === "string" ? { boardId: value.boardId } : {}),
    ...(typeof value.createdByCardId === "string"
      ? { createdByCardId: value.createdByCardId }
      : {}),
    ...(typeof value.idempotencyKey === "string" ? { idempotencyKey: value.idempotencyKey } : {}),
    ...(normalizeStringArray(value.skills).length
      ? { skills: normalizeStringArray(value.skills) }
      : {}),
    ...(workspace?.kind ? { workspace: workspace as WorkboardWorkspace } : {}),
    ...(typeof value.maxRuntimeSeconds === "number"
      ? { maxRuntimeSeconds: value.maxRuntimeSeconds }
      : {}),
    ...(typeof value.maxRetries === "number" ? { maxRetries: value.maxRetries } : {}),
    ...(typeof value.scheduledAt === "number" ? { scheduledAt: value.scheduledAt } : {}),
    ...(typeof value.summary === "string" ? { summary: value.summary } : {}),
    ...(normalizeStringArray(value.createdCardIds).length
      ? { createdCardIds: normalizeStringArray(value.createdCardIds) }
      : {}),
    ...(typeof value.dispatchCount === "number" ? { dispatchCount: value.dispatchCount } : {}),
    ...(typeof value.lastDispatchAt === "number" ? { lastDispatchAt: value.lastDispatchAt } : {}),
  };
  return Object.keys(automation).length ? automation : undefined;
}

export function normalizeMetadata(value: unknown): WorkboardMetadata | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const attempts = Array.isArray(value.attempts)
    ? value.attempts.flatMap((entry): WorkboardRunAttempt[] => {
        if (
          !isRecord(entry) ||
          typeof entry.id !== "string" ||
          typeof entry.startedAt !== "number"
        ) {
          return [];
        }
        const status = WORKBOARD_ATTEMPT_STATUSES.includes(entry.status as WorkboardAttemptStatus)
          ? (entry.status as WorkboardAttemptStatus)
          : "running";
        return [
          {
            id: entry.id,
            status,
            startedAt: entry.startedAt,
            ...(typeof entry.endedAt === "number" ? { endedAt: entry.endedAt } : {}),
            ...(WORKBOARD_EXECUTION_ENGINES.includes(entry.engine as WorkboardExecutionEngine)
              ? { engine: entry.engine as WorkboardExecutionEngine }
              : {}),
            ...(WORKBOARD_EXECUTION_MODES.includes(entry.mode as WorkboardExecutionMode)
              ? { mode: entry.mode as WorkboardExecutionMode }
              : {}),
            ...(typeof entry.model === "string" ? { model: entry.model } : {}),
            ...(typeof entry.sessionKey === "string" ? { sessionKey: entry.sessionKey } : {}),
            ...(typeof entry.runId === "string" ? { runId: entry.runId } : {}),
            ...(typeof entry.error === "string" ? { error: entry.error } : {}),
          },
        ];
      })
    : [];
  const comments = Array.isArray(value.comments)
    ? value.comments.flatMap((entry): WorkboardComment[] => {
        if (
          !isRecord(entry) ||
          typeof entry.id !== "string" ||
          typeof entry.body !== "string" ||
          typeof entry.createdAt !== "number"
        ) {
          return [];
        }
        return [
          {
            id: entry.id,
            body: entry.body,
            createdAt: entry.createdAt,
            ...(typeof entry.updatedAt === "number" ? { updatedAt: entry.updatedAt } : {}),
          },
        ];
      })
    : [];
  const links = Array.isArray(value.links)
    ? value.links.flatMap((entry): WorkboardLink[] => {
        if (
          !isRecord(entry) ||
          typeof entry.id !== "string" ||
          typeof entry.createdAt !== "number"
        ) {
          return [];
        }
        return [
          {
            id: entry.id,
            type: WORKBOARD_LINK_TYPES.includes(entry.type as WorkboardLinkType)
              ? (entry.type as WorkboardLinkType)
              : "relates_to",
            createdAt: entry.createdAt,
            ...(typeof entry.targetCardId === "string" ? { targetCardId: entry.targetCardId } : {}),
            ...(typeof entry.title === "string" ? { title: entry.title } : {}),
            ...(typeof entry.url === "string" ? { url: entry.url } : {}),
          },
        ];
      })
    : [];
  const proof = Array.isArray(value.proof)
    ? value.proof.flatMap((entry): WorkboardProof[] => {
        if (
          !isRecord(entry) ||
          typeof entry.id !== "string" ||
          typeof entry.createdAt !== "number"
        ) {
          return [];
        }
        return [
          {
            id: entry.id,
            status: WORKBOARD_PROOF_STATUSES.includes(entry.status as WorkboardProofStatus)
              ? (entry.status as WorkboardProofStatus)
              : "unknown",
            createdAt: entry.createdAt,
            ...(typeof entry.label === "string" ? { label: entry.label } : {}),
            ...(typeof entry.command === "string" ? { command: entry.command } : {}),
            ...(typeof entry.url === "string" ? { url: entry.url } : {}),
            ...(typeof entry.note === "string" ? { note: entry.note } : {}),
          },
        ];
      })
    : [];
  const artifacts = Array.isArray(value.artifacts)
    ? value.artifacts.flatMap((entry): WorkboardArtifact[] => {
        if (
          !isRecord(entry) ||
          typeof entry.id !== "string" ||
          typeof entry.createdAt !== "number"
        ) {
          return [];
        }
        return [
          {
            id: entry.id,
            createdAt: entry.createdAt,
            ...(typeof entry.label === "string" ? { label: entry.label } : {}),
            ...(typeof entry.url === "string" ? { url: entry.url } : {}),
            ...(typeof entry.path === "string" ? { path: entry.path } : {}),
            ...(typeof entry.mimeType === "string" ? { mimeType: entry.mimeType } : {}),
          },
        ];
      })
    : [];
  const attachments = Array.isArray(value.attachments)
    ? value.attachments.flatMap((entry): WorkboardAttachment[] => {
        if (
          !isRecord(entry) ||
          typeof entry.id !== "string" ||
          typeof entry.cardId !== "string" ||
          typeof entry.fileName !== "string" ||
          typeof entry.byteSize !== "number" ||
          typeof entry.createdAt !== "number"
        ) {
          return [];
        }
        return [
          {
            id: entry.id,
            cardId: entry.cardId,
            fileName: entry.fileName,
            byteSize: entry.byteSize,
            createdAt: entry.createdAt,
            ...(typeof entry.mimeType === "string" ? { mimeType: entry.mimeType } : {}),
            ...(typeof entry.note === "string" ? { note: entry.note } : {}),
          },
        ];
      })
    : [];
  const workerLogs = Array.isArray(value.workerLogs)
    ? value.workerLogs.flatMap((entry): WorkboardWorkerLog[] => {
        if (
          !isRecord(entry) ||
          typeof entry.id !== "string" ||
          typeof entry.message !== "string" ||
          typeof entry.createdAt !== "number"
        ) {
          return [];
        }
        return [
          {
            id: entry.id,
            level:
              entry.level === "warning" || entry.level === "error" || entry.level === "info"
                ? entry.level
                : "info",
            message: entry.message,
            createdAt: entry.createdAt,
            ...(typeof entry.sessionKey === "string" ? { sessionKey: entry.sessionKey } : {}),
            ...(typeof entry.runId === "string" ? { runId: entry.runId } : {}),
          },
        ];
      })
    : [];
  const workerProtocolRecord = isRecord(value.workerProtocol) ? value.workerProtocol : null;
  const workerProtocolState = normalizeWorkerProtocolState(workerProtocolRecord?.state);
  const workerProtocol = workerProtocolState
    ? {
        state: workerProtocolState,
        updatedAt:
          typeof workerProtocolRecord?.updatedAt === "number"
            ? workerProtocolRecord.updatedAt
            : Date.now(),
        ...(typeof workerProtocolRecord?.detail === "string"
          ? { detail: workerProtocolRecord.detail }
          : {}),
      }
    : undefined;
  const claim = isRecord(value.claim)
    ? {
        ownerId: typeof value.claim.ownerId === "string" ? value.claim.ownerId : "",
        ...(typeof value.claim.token === "string" ? { token: value.claim.token } : {}),
        claimedAt: typeof value.claim.claimedAt === "number" ? value.claim.claimedAt : 0,
        lastHeartbeatAt:
          typeof value.claim.lastHeartbeatAt === "number" ? value.claim.lastHeartbeatAt : 0,
        ...(typeof value.claim.expiresAt === "number" ? { expiresAt: value.claim.expiresAt } : {}),
      }
    : undefined;
  const diagnostics = Array.isArray(value.diagnostics)
    ? value.diagnostics.flatMap((entry): WorkboardDiagnostic[] => {
        if (!isRecord(entry) || typeof entry.kind !== "string" || typeof entry.title !== "string") {
          return [];
        }
        return [
          {
            kind: entry.kind,
            severity: WORKBOARD_DIAGNOSTIC_SEVERITIES.includes(
              entry.severity as WorkboardDiagnosticSeverity,
            )
              ? (entry.severity as WorkboardDiagnosticSeverity)
              : "warning",
            title: entry.title,
            detail: typeof entry.detail === "string" ? entry.detail : entry.title,
            firstSeenAt: typeof entry.firstSeenAt === "number" ? entry.firstSeenAt : Date.now(),
            lastSeenAt: typeof entry.lastSeenAt === "number" ? entry.lastSeenAt : Date.now(),
            count: typeof entry.count === "number" ? entry.count : 1,
          },
        ];
      })
    : [];
  const notifications = Array.isArray(value.notifications)
    ? value.notifications.flatMap((entry): WorkboardNotification[] => {
        if (
          !isRecord(entry) ||
          typeof entry.id !== "string" ||
          typeof entry.kind !== "string" ||
          typeof entry.message !== "string" ||
          typeof entry.createdAt !== "number"
        ) {
          return [];
        }
        return [
          {
            id: entry.id,
            kind: entry.kind,
            message: entry.message,
            createdAt: entry.createdAt,
            ...(typeof entry.sessionKey === "string" ? { sessionKey: entry.sessionKey } : {}),
            ...(typeof entry.runId === "string" ? { runId: entry.runId } : {}),
          },
        ];
      })
    : [];
  const stale = isRecord(value.stale)
    ? {
        detectedAt:
          typeof value.stale.detectedAt === "number" ? value.stale.detectedAt : Date.now(),
        ...(typeof value.stale.lastSessionUpdatedAt === "number"
          ? { lastSessionUpdatedAt: value.stale.lastSessionUpdatedAt }
          : {}),
        reason:
          typeof value.stale.reason === "string"
            ? value.stale.reason
            : "Session has not reported recent activity.",
      }
    : undefined;
  const automation = normalizeAutomation(value.automation);
  const lifecycleStatusSourceUpdatedAt =
    typeof value.lifecycleStatusSourceUpdatedAt === "number" &&
    Number.isFinite(value.lifecycleStatusSourceUpdatedAt)
      ? Math.max(0, Math.trunc(value.lifecycleStatusSourceUpdatedAt))
      : undefined;
  const metadata: WorkboardMetadata = {
    ...(attempts.length ? { attempts } : {}),
    ...(comments.length ? { comments } : {}),
    ...(links.length ? { links } : {}),
    ...(proof.length ? { proof } : {}),
    ...(artifacts.length ? { artifacts } : {}),
    ...(attachments.length ? { attachments } : {}),
    ...(workerLogs.length ? { workerLogs } : {}),
    ...(workerProtocol ? { workerProtocol } : {}),
    ...(automation ? { automation } : {}),
    ...(claim?.ownerId && claim.claimedAt ? { claim } : {}),
    ...(diagnostics.length ? { diagnostics } : {}),
    ...(notifications.length ? { notifications } : {}),
    ...(WORKBOARD_TEMPLATE_IDS.includes(value.templateId as WorkboardTemplateId)
      ? { templateId: value.templateId as WorkboardTemplateId }
      : {}),
    ...(typeof value.archivedAt === "number" ? { archivedAt: value.archivedAt } : {}),
    ...(stale ? { stale } : {}),
    ...(lifecycleStatusSourceUpdatedAt !== undefined ? { lifecycleStatusSourceUpdatedAt } : {}),
    ...(typeof value.failureCount === "number" ? { failureCount: value.failureCount } : {}),
  };
  return Object.keys(metadata).length ? metadata : undefined;
}
