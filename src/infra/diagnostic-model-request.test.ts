import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  emitTrustedDiagnosticEvent,
  onInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
  waitForDiagnosticEventsDrained,
} from "./diagnostic-events.js";
import { isCoreModelRequestStartedDiagnosticMetadata } from "./diagnostic-model-request.js";

describe("core model request provenance", () => {
  beforeEach(() => resetDiagnosticEventsForTest());
  afterEach(() => resetDiagnosticEventsForTest());

  it("keeps duplicate-emitter provenance attached to its FIFO event", async () => {
    const events: Array<{ callId: string; coreRequest: boolean }> = [];
    onInternalDiagnosticEvent((event, metadata) => {
      if (event.type === "model.call.started") {
        events.push({
          callId: event.callId,
          coreRequest: isCoreModelRequestStartedDiagnosticMetadata(metadata),
        });
      }
    });

    vi.resetModules();
    const duplicateModelRequest = await import(
      /* @vite-ignore */ new URL("./diagnostic-model-request.ts?duplicate", import.meta.url).href
    );
    duplicateModelRequest.emitCoreModelRequestStartedDiagnosticEvent({
      runId: "fifo-run",
      callId: "core-before",
      provider: "mock",
      model: "request-model",
    });
    emitTrustedDiagnosticEvent({
      type: "model.call.started",
      runId: "fifo-run",
      callId: "public-middle",
      provider: "mock",
      model: "request-model",
      observationUnit: "request",
    });
    duplicateModelRequest.emitCoreModelRequestStartedDiagnosticEvent({
      runId: "fifo-run",
      callId: "core-after",
      provider: "mock",
      model: "request-model",
    });
    await waitForDiagnosticEventsDrained();

    expect(events).toEqual([
      { callId: "core-before", coreRequest: true },
      { callId: "public-middle", coreRequest: false },
      { callId: "core-after", coreRequest: true },
    ]);
  });
});
