// Diagnostic log capture helpers collect emitted diagnostic logs for tests.
import {
  onInternalDiagnosticEvent,
  type DiagnosticEventPayload,
} from "../../infra/diagnostic-events.js";

/** Captured diagnostic event shape for emitted log records. */
export type CapturedDiagnosticLogRecord = Extract<DiagnosticEventPayload, { type: "log.record" }>;

/** Flushes asynchronous diagnostic log record delivery. */
export async function flushDiagnosticLogRecords(): Promise<void> {
  for (let index = 0; index < 3; index += 1) {
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
