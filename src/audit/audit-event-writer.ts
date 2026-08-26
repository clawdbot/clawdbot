/** Non-blocking process-owned queue for audit metadata persistence. */
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { DecisionReceiptV1 } from "../../packages/gateway-protocol/src/index.js";
import { resolveStateDir } from "../config/paths.js";
import { redactSensitiveText } from "../logging/redact.js";
import {
  OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
  runWithOpenClawStateBusyTimeout,
} from "../state/openclaw-state-db.js";
import { isOpenClawStateWriteContentionError } from "../state/openclaw-state-ownership.js";
import { pruneExpiredAuditEvents, recordAuditEvent } from "./audit-event-store.js";
import { isOutboundMessageProgressInput, type AuditEventInput } from "./audit-event-types.js";
import {
  pruneExpiredExecutionDecisionFacts,
  recordExecutionDecisionFact,
} from "./execution-decision-facts.js";
import {
  parseExecutionDecisionWork,
  processExecutionDecisionWork,
  type ExecutionDecisionWork,
} from "./execution-decision-work.js";
import type { ExecutionIdentityAdmissionWork } from "./execution-identity-admission.js";
import {
  processExecutionIdentityAdmissionWork,
  pruneExpiredExecutionIdentityContexts,
} from "./execution-identity-context.js";
import {
  pruneExpiredOutboundMessageProgress,
  recordOutboundMessageProgress,
} from "./message-delivery-progress-store.js";

const MAX_PENDING_AUDIT_EVENTS = 4_096;
const AUDIT_MAINTENANCE_INTERVAL_MS = 60 * 60_000;
const AUDIT_LOCK_RETRY_DELAY_MS = 25;
const AUDIT_LOCK_RETRY_MAX_DELAY_MS = 1_000;
const AUDIT_LOCK_CONTENTION_REPORT_MS = 1_000;
const AUDIT_WRITER_SHUTDOWN_TIMEOUT_MS = OPENCLAW_SQLITE_BUSY_TIMEOUT_MS + 5_000;

type AuditWriterAttempt = "settled" | "retry";
type AuditMaintenanceAttempt = "settled" | "more" | "retry";

type AuditWriterRequest =
  | { type: "record-event"; input: AuditEventInput }
  | { type: "record-execution-identity"; work: ExecutionIdentityAdmissionWork }
  | { type: "record-execution-decision"; receipt: DecisionReceiptV1 }
  | { type: "record-execution-decision-work"; work: ExecutionDecisionWork };

export type AuditEventWriter = {
  ready: Promise<void>;
  record: (input: AuditEventInput) => boolean;
  /** Reports only queue acceptance; persistence succeeds or fails asynchronously. */
  recordExecutionIdentity: (work: ExecutionIdentityAdmissionWork) => boolean;
  /** For decision owners without a native durable record; approvals must not use this path. */
  recordExecutionDecision: (receipt: DecisionReceiptV1) => boolean;
  /** Raw private refs are projected only after this work reaches the FIFO owner. */
  recordExecutionDecisionWork: (work: ExecutionDecisionWork) => boolean;
  stop: () => Promise<void>;
};

function formatAuditWriterError(error: unknown): string {
  return truncateUtf16Safe(
    redactSensitiveText(error instanceof Error ? error.message : String(error), { mode: "tools" }),
    512,
  );
}

function executionIdentityFailureMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (
    message.includes("audit identity key is missing") ||
    message.includes("audit identity key is corrupt")
  ) {
    return "audit execution identity key unavailable";
  }
  if (message.includes("execution identity context conflict")) {
    return "audit execution identity context conflict";
  }
  if (message.includes("execution identity recovery evidence unavailable")) {
    return "audit execution identity recovery evidence unavailable";
  }
  if (
    message.includes("admission envelope") ||
    message.includes("admission work") ||
    message.includes("admission token")
  ) {
    return "audit execution identity envelope rejected";
  }
  return "audit execution identity persistence failed";
}

/** Start one bounded queue on the current process's cached shared-state connection owner. */
export function createAuditEventWriter(
  options: {
    stateDir?: string;
    maxPending?: number;
    onContention?: (message: string) => void;
    onError?: (error: string) => void;
  } = {},
): AuditEventWriter {
  const database = {
    env: { OPENCLAW_STATE_DIR: options.stateDir ?? resolveStateDir(process.env) },
  };
  const maxPending = Math.max(1, Math.floor(options.maxPending ?? MAX_PENDING_AUDIT_EVENTS));
  const queue: AuditWriterRequest[] = [];
  let stopped = false;
  let unavailable = false;
  let maintenancePending = true;
  let readyPending = true;
  let scheduled: ReturnType<typeof setImmediate> | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let lockRetryAttempt = 0;
  let lockContentionDelayMs = 0;
  let lockContentionReported = false;
  let resolveReady!: () => void;
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });
  let stopPromise: Promise<void> | undefined;
  let resolveStop: (() => void) | undefined;
  let stopTimer: ReturnType<typeof setTimeout> | undefined;

  const fail = (error: unknown) => {
    options.onError?.(formatAuditWriterError(error));
  };
  const reportContention = (message: string) => {
    options.onContention?.(formatAuditWriterError(message));
  };
  const runWithoutBusyWait = <T>(operation: () => T): T =>
    runWithOpenClawStateBusyTimeout(() => operation(), database, 0);
  const observeLockContention = () => {
    lockRetryAttempt += 1;
  };
  const resetLockContention = () => {
    lockRetryAttempt = 0;
    lockContentionDelayMs = 0;
    lockContentionReported = false;
  };
  const reportMaintenance = (): AuditMaintenanceAttempt => {
    let more = false;
    for (const maintenance of [
      () => pruneExpiredAuditEvents({ database }),
      () => pruneExpiredExecutionIdentityContexts({ database }),
      () => pruneExpiredExecutionDecisionFacts({ database }),
      () => pruneExpiredOutboundMessageProgress({ database }),
    ]) {
      try {
        more = runWithoutBusyWait(maintenance) > 0 || more;
      } catch (error) {
        if (isOpenClawStateWriteContentionError(error)) {
          observeLockContention();
          return "retry";
        }
        fail(error);
      }
    }
    return more ? "more" : "settled";
  };
  const processRequest = (request: AuditWriterRequest): AuditWriterAttempt => {
    try {
      runWithoutBusyWait(() => {
        if (request.type === "record-event") {
          if (isOutboundMessageProgressInput(request.input)) {
            recordOutboundMessageProgress(request.input, database);
          } else {
            recordAuditEvent(request.input, database);
          }
          return;
        }
        if (request.type === "record-execution-identity") {
          processExecutionIdentityAdmissionWork(request.work, database);
          return;
        }
        if (request.type === "record-execution-decision-work") {
          processExecutionDecisionWork(request.work, database);
          return;
        }
        recordExecutionDecisionFact(request.receipt, database);
      });
      return "settled";
    } catch (error) {
      if (isOpenClawStateWriteContentionError(error)) {
        observeLockContention();
        return "retry";
      }
      resetLockContention();
      if (request.type === "record-execution-identity") {
        fail(executionIdentityFailureMessage(error));
      } else if (
        request.type === "record-execution-decision" ||
        request.type === "record-execution-decision-work"
      ) {
        fail("audit execution decision rejected");
      } else {
        fail(error);
      }
      return "settled";
    }
  };
  const finishStop = () => {
    if (stopTimer) {
      clearTimeout(stopTimer);
      stopTimer = undefined;
    }
    const finish = resolveStop;
    resolveStop = undefined;
    finish?.();
  };
  const schedule = () => {
    if (retryTimer) {
      if (stopped) {
        retryTimer.ref?.();
      }
      return;
    }
    if (scheduled) {
      if (stopped) {
        scheduled.ref?.();
      }
      return;
    }
    scheduled = setImmediate(drainOne);
    if (!stopped) {
      scheduled.unref?.();
    }
  };
  const scheduleRetry = () => {
    const delayMs = Math.min(
      AUDIT_LOCK_RETRY_MAX_DELAY_MS,
      AUDIT_LOCK_RETRY_DELAY_MS * 2 ** Math.min(6, Math.max(0, lockRetryAttempt - 1)),
    );
    lockContentionDelayMs += delayMs;
    if (!lockContentionReported && lockContentionDelayMs >= AUDIT_LOCK_CONTENTION_REPORT_MS) {
      lockContentionReported = true;
      reportContention("audit event persistence delayed by SQLite lock contention");
    }
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      drainOne();
    }, delayMs);
    if (!stopped) {
      retryTimer.unref?.();
    }
  };
  function drainOne() {
    scheduled = undefined;
    if (maintenancePending) {
      const maintenance = reportMaintenance();
      if (readyPending) {
        readyPending = false;
        resolveReady();
      }
      if (maintenance === "retry") {
        scheduleRetry();
        return;
      }
      maintenancePending = maintenance === "more";
      resetLockContention();
    }
    const request = queue.shift();
    if (request && processRequest(request) === "retry") {
      queue.unshift(request);
      scheduleRetry();
      return;
    }
    if (request) {
      resetLockContention();
    }
    if (queue.length > 0 || maintenancePending) {
      schedule();
      return;
    }
    if (stopped) {
      finishStop();
    }
  }
  const maintenanceTimer = setInterval(() => {
    maintenancePending = true;
    schedule();
  }, AUDIT_MAINTENANCE_INTERVAL_MS);
  maintenanceTimer.unref?.();
  schedule();

  const enqueue = (message: AuditWriterRequest): boolean => {
    if (stopped || unavailable || queue.length >= maxPending) {
      if (!stopped) {
        fail(
          unavailable
            ? "audit event writer is unavailable; dropping metadata"
            : `audit event queue is full (${maxPending}); dropping metadata`,
        );
      }
      return false;
    }
    try {
      const boundedMessage =
        message.type === "record-execution-decision-work"
          ? { ...message, work: parseExecutionDecisionWork(message.work) }
          : message;
      // Preserve the former Worker boundary's clone and prototype-stripping contract.
      queue.push(structuredClone(boundedMessage));
      schedule();
      return true;
    } catch (error) {
      if (message.type !== "record-event") {
        fail(
          message.type === "record-execution-identity"
            ? "audit execution identity envelope could not be queued"
            : "audit execution decision receipt could not be queued",
        );
      } else {
        unavailable = true;
        fail(error);
      }
      return false;
    }
  };

  return {
    ready,
    record: (input) => enqueue({ type: "record-event", input }),
    recordExecutionIdentity: (work) => enqueue({ type: "record-execution-identity", work }),
    recordExecutionDecision: (receipt) => enqueue({ type: "record-execution-decision", receipt }),
    recordExecutionDecisionWork: (work) =>
      enqueue({ type: "record-execution-decision-work", work }),
    stop: () => {
      if (stopPromise) {
        return stopPromise;
      }
      stopped = true;
      clearInterval(maintenanceTimer);
      maintenancePending = true;
      stopPromise = new Promise<void>((resolve) => {
        resolveStop = resolve;
        stopTimer = setTimeout(() => {
          queue.length = 0;
          if (scheduled) {
            clearImmediate(scheduled);
            scheduled = undefined;
          }
          if (retryTimer) {
            clearTimeout(retryTimer);
            retryTimer = undefined;
          }
          fail("audit event writer shutdown timed out; pending metadata may be lost");
          finishStop();
        }, AUDIT_WRITER_SHUTDOWN_TIMEOUT_MS);
        stopTimer.unref?.();
        schedule();
      });
      return stopPromise;
    },
  };
}
