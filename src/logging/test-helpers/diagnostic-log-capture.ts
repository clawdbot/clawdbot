import {
  onInternalDiagnosticEvent,
  type DiagnosticEventPayload,
} from "../../infra/diagnostic-events.js";

export type CapturedDiagnosticLogRecord = Extract<DiagnosticEventPayload, { type: "log.record" }>;

export function flushDiagnosticLogRecords(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

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
