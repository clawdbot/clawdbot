import {
  onInternalDiagnosticEvent,
  type DiagnosticEventPayload,
} from "../../infra/diagnostic-events.js";

export type CapturedDiagnosticLogRecord = Extract<DiagnosticEventPayload, { type: "log.record" }>;

export async function flushDiagnosticLogRecords(): Promise<void> {
  for (let index = 0; index < 3; index += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
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
