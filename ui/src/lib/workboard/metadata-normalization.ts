import {
  normalizeAutomation,
  normalizeDiagnosticAction,
} from "./metadata-contract-normalization.ts";
import { isRecord } from "./normalization-utils.ts";
import {
  WORKBOARD_ATTEMPT_STATUSES,
  WORKBOARD_DIAGNOSTIC_KINDS,
  WORKBOARD_DIAGNOSTIC_SEVERITIES,
  WORKBOARD_EVENT_KINDS,
  WORKBOARD_EXECUTION_MODES,
  WORKBOARD_EXECUTION_STATUSES,
  WORKBOARD_LINK_TYPES,
  WORKBOARD_NOTIFICATION_KINDS,
  WORKBOARD_PROOF_STATUSES,
  WORKBOARD_STATUSES,
  WORKBOARD_TEMPLATE_IDS,
  type WorkboardArtifact,
  type WorkboardAttachment,
  type WorkboardAttemptStatus,
  type WorkboardClaim,
  type WorkboardComment,
  type WorkboardDiagnostic,
  type WorkboardDiagnosticAction,
  type WorkboardDiagnosticKind,
  type WorkboardDiagnosticSeverity,
  type WorkboardEvent,
  type WorkboardEventKind,
  type WorkboardExecution,
  type WorkboardExecutionMode,
  type WorkboardExecutionStatus,
  type WorkboardLink,
  type WorkboardLinkType,
  type WorkboardMetadata,
  type WorkboardNotification,
  type WorkboardNotificationKind,
  type WorkboardProof,
  type WorkboardProofStatus,
  type WorkboardRunAttempt,
  type WorkboardStatus,
  type WorkboardTemplateId,
  type WorkboardWorkerLog,
  type WorkboardWorkerProtocol,
} from "./types.ts";

export function normalizeExecution(value: unknown): WorkboardExecution | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const id = typeof value.id === "string" && value.id.trim() ? value.id.trim() : "";
  const engine = typeof value.engine === "string" ? value.engine.trim() : "";
  const mode = WORKBOARD_EXECUTION_MODES.includes(value.mode as WorkboardExecutionMode)
    ? (value.mode as WorkboardExecutionMode)
    : null;
  const status = WORKBOARD_EXECUTION_STATUSES.includes(value.status as WorkboardExecutionStatus)
    ? (value.status as WorkboardExecutionStatus)
    : "idle";
  const model = typeof value.model === "string" && value.model.trim() ? value.model.trim() : "";
  const startedAt = typeof value.startedAt === "number" ? value.startedAt : 0;
  const updatedAt = typeof value.updatedAt === "number" ? value.updatedAt : startedAt;
  if (!id || !mode || !startedAt) {
    return undefined;
  }
  return {
    id,
    kind: "agent-session",
    mode,
    status,
    startedAt,
    updatedAt,
    ...(engine ? { engine } : {}),
    ...(model ? { model } : {}),
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
        const engine = typeof entry.engine === "string" ? entry.engine.trim() : "";
        return [
          {
            id: entry.id,
            status,
            startedAt: entry.startedAt,
            ...(typeof entry.endedAt === "number" ? { endedAt: entry.endedAt } : {}),
            ...(engine ? { engine } : {}),
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
  const claim: WorkboardClaim | undefined =
    isRecord(value.claim) &&
    typeof value.claim.ownerId === "string" &&
    typeof value.claim.token === "string" &&
    typeof value.claim.claimedAt === "number" &&
    typeof value.claim.lastHeartbeatAt === "number"
      ? {
          ownerId: value.claim.ownerId,
          token: value.claim.token,
          claimedAt: value.claim.claimedAt,
          lastHeartbeatAt: value.claim.lastHeartbeatAt,
          ...(typeof value.claim.expiresAt === "number"
            ? { expiresAt: value.claim.expiresAt }
            : {}),
        }
      : undefined;
  const diagnostics = Array.isArray(value.diagnostics)
    ? value.diagnostics.flatMap((entry): WorkboardDiagnostic[] => {
        if (
          !isRecord(entry) ||
          !WORKBOARD_DIAGNOSTIC_KINDS.includes(entry.kind as WorkboardDiagnosticKind) ||
          !WORKBOARD_DIAGNOSTIC_SEVERITIES.includes(
            entry.severity as WorkboardDiagnosticSeverity,
          ) ||
          typeof entry.title !== "string"
        ) {
          return [];
        }
        return [
          {
            kind: entry.kind as WorkboardDiagnosticKind,
            severity: entry.severity as WorkboardDiagnosticSeverity,
            title: entry.title,
            detail: typeof entry.detail === "string" ? entry.detail : entry.title,
            firstSeenAt: typeof entry.firstSeenAt === "number" ? entry.firstSeenAt : Date.now(),
            lastSeenAt: typeof entry.lastSeenAt === "number" ? entry.lastSeenAt : Date.now(),
            count: typeof entry.count === "number" ? entry.count : 1,
            actions: Array.isArray(entry.actions)
              ? entry.actions
                  .map(normalizeDiagnosticAction)
                  .filter((action): action is WorkboardDiagnosticAction => action !== null)
              : [],
          },
        ];
      })
    : [];
  const notifications = Array.isArray(value.notifications)
    ? value.notifications.flatMap((entry): WorkboardNotification[] => {
        if (
          !isRecord(entry) ||
          typeof entry.id !== "string" ||
          !WORKBOARD_NOTIFICATION_KINDS.includes(entry.kind as WorkboardNotificationKind) ||
          typeof entry.message !== "string" ||
          typeof entry.createdAt !== "number"
        ) {
          return [];
        }
        return [
          {
            id: entry.id,
            kind: entry.kind as WorkboardNotificationKind,
            message: entry.message,
            createdAt: entry.createdAt,
            ...(typeof entry.sequence === "number" ? { sequence: entry.sequence } : {}),
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
    ...(claim ? { claim } : {}),
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
