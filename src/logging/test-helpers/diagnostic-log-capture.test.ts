import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  emitDiagnosticEvent,
  resetDiagnosticEventsForTest,
} from "../../infra/diagnostic-events.js";
import { createDiagnosticLogRecordCapture } from "./diagnostic-log-capture.js";

describe("diagnostic log capture", () => {
  beforeEach(() => {
    resetDiagnosticEventsForTest();
  });

  afterEach(() => {
    resetDiagnosticEventsForTest();
  });

  it("flushes log records queued behind multiple diagnostic batches", async () => {
    const capture = createDiagnosticLogRecordCapture();
    for (let index = 0; index < 350; index += 1) {
      emitDiagnosticEvent({
        type: "log.record",
        level: "warn",
        message: `warning-${index}`,
      });
    }

    await capture.flush();

    expect(capture.records).toHaveLength(350);
    capture.cleanup();
  });
});
