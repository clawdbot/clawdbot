// Diagnostic log capture helpers collect emitted diagnostic logs for tests.
import {
  hasPendingInternalDiagnosticEvent,
  onInternalDiagnosticEvent,
  type DiagnosticEventPayload,
} from "../../infra/diagnostic-events.js";

/** Captured diagnostic event shape for emitted log records. */
type CapturedDiagnosticLogRecord = Extract<DiagnosticEventPayload, { type: "log.record" }>;

/** Flushes asynchronous diagnostic log record delivery. */
async function flushDiagnosticLogRecords(): Promise<void> {
  // The dispatcher drains 100 records per turn. A busy shared test process can
  // have several batches ahead of the log under test, so wait for queued log
  // records instead of assuming a fixed small number of turns.
  for (let index = 0; index < 128; index += 1) {
    if (!hasPendingInternalDiagnosticEvent((event) => event.type === "log.record")) {
      return;
    }
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
}

/** Captures diagnostic log records until cleanup is called. */
export function createDiagnosticLogRecordCapture() {
  const records: CapturedDiagnosticLogRecord[] = [];
  const unsubscribe = onInternalDiagnosticEvent((event) => {
    if (event.type === "log.record") {
      records.push(event);
    }
  });

  return {
    records,
    flush: flushDiagnosticLogRecords,
    cleanup: unsubscribe,
  };
}
