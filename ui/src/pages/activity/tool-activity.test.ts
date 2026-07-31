// @vitest-environment node
import { describe, expect, it } from "vitest";
import { parseActivityEvent, updateToolActivity, type ActivityEntry } from "./tool-activity.ts";

function buildResultPreview(result: unknown): string {
  const entries: ActivityEntry[] = updateToolActivity([], {
    stream: "tool",
    runId: "run-1",
    ts: 1,
    receivedAt: 1,
    data: {
      toolCallId: "tool-1",
      name: "bash",
      phase: "result",
      result,
    },
  });

  const entry = entries[0];
  if (!entry?.outputPreview) {
    throw new Error("Expected activity output preview");
  }
  return entry.outputPreview;
}

describe("activity model output preview redaction", () => {
  it("redacts dotted API key assignments emitted by tool output", () => {
    const preview = buildResultPreview({
      text: [
        "app.api.key=visible-leaked-value-1234567890",
        "spring.datasource.password=visible-db-password-1234567890",
        "server.port=8080",
      ].join("\n"),
    });

    expect(preview).toContain("app.api.key=[redacted]");
    expect(preview).toContain("spring.datasource.password=[redacted]");
    expect(preview).toContain("server.port=8080");
    expect(preview).not.toContain("visible-leaked-value-1234567890");
    expect(preview).not.toContain("visible-db-password-1234567890");
  });

  it("redacts dotted API keys in object-shaped tool results", () => {
    const preview = buildResultPreview({
      "app.api.key": 'visible secret with spaces, apostrophe: don\'t, quote: "keep hidden"',
      "server.port": 8080,
    });

    expect(preview).toContain('"app.api.key": "[redacted]"');
    expect(preview).toContain('"server.port": 8080');
    expect(preview).not.toContain("visible secret");
    expect(preview).not.toContain("keep hidden");
  });
});

describe("answer candidate activity", () => {
  it("updates one ephemeral entry from candidate through authoritative selection", () => {
    const candidate = parseActivityEvent(
      {
        stream: "item",
        runId: "run-1",
        ts: 10,
        data: {
          kind: "answer_candidate",
          itemId: "answer-1",
          status: "candidate",
          progressText: "First draft",
        },
      },
      10,
    );
    if (!candidate) {
      throw new Error("Expected answer candidate event");
    }
    const selected = parseActivityEvent(
      {
        stream: "item",
        runId: "run-1",
        ts: 10,
        data: {
          kind: "answer_candidate",
          itemId: "answer-1",
          status: "selected",
          progressText: "Final answer",
        },
      },
      20,
    );
    if (!selected) {
      throw new Error("Expected selected answer event");
    }

    const entries = updateToolActivity(updateToolActivity([], candidate), selected);

    expect(entries).toEqual([
      expect.objectContaining({
        id: "run-1:answer_candidate:answer-1",
        entryKind: "answer_candidate",
        itemId: "answer-1",
        candidateStatus: "selected",
        status: "done",
        outputPreview: "Final answer",
      }),
    ]);
  });

  it("ignores unrelated item events", () => {
    expect(
      parseActivityEvent({
        stream: "item",
        runId: "run-1",
        data: { kind: "preamble", itemId: "note-1" },
      }),
    ).toBeNull();
  });
});
