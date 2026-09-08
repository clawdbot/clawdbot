import { describe, expect, it } from "vitest";
import {
  parseWorkerProcessRequest,
  parseWorkerProcessResult,
  parseWorkerRuntimeResult,
} from "./worker-process-protocol.js";

function inheritedRecord(
  prototype: Record<string, unknown>,
  ownFields: Record<string, unknown>,
): Record<string, unknown> {
  return Object.assign(Object.create(prototype) as Record<string, unknown>, ownFields);
}

describe("worker process protocol", () => {
  it("rejects request discriminators inherited alongside the wrong own keys", () => {
    const request = inheritedRecord({ type: "cancel" }, { turnId: "turn-1", unexpected: true });

    expect(() => parseWorkerProcessRequest(request)).toThrow("invalid managed worker request");
  });

  it.each([
    {
      name: "fenced result",
      value: inheritedRecord(
        { status: "fenced" },
        { reason: "credential-replaced", unexpected: true },
      ),
    },
    {
      name: "admission deadline result",
      value: inheritedRecord(
        { status: "not-started", reason: "admission-deadline" },
        { errorText: "worker admission timed out", unexpected: true, ignored: true },
      ),
    },
    {
      name: "completed result",
      value: inheritedRecord(
        { status: "completed" },
        { transcriptLeafId: null, transcriptNextSeq: 1, unexpected: true },
      ),
    },
    {
      name: "failed result",
      value: inheritedRecord(
        { status: "failed", reason: "turn-failed" },
        {
          transcriptLeafId: null,
          transcriptNextSeq: 1,
          unexpected: true,
          ignored: true,
        },
      ),
    },
  ])("rejects an inherited discriminator for a $name", ({ value }) => {
    expect(parseWorkerRuntimeResult(value)).toBeNull();
  });

  it("rejects process-result types inherited alongside the wrong own keys", () => {
    const result = inheritedRecord(
      { type: "result" },
      {
        turnId: "turn-1",
        result: { status: "completed", transcriptLeafId: null, transcriptNextSeq: 1 },
        retainWorker: false,
        unexpected: true,
      },
    );

    expect(parseWorkerProcessResult(result)).toBeNull();
  });
});
