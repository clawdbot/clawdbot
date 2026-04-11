import { describe, expect, it } from "vitest";
import { resolveCronPayloadOutcome } from "./isolated-agent/helpers.js";

describe("resolveCronPayloadOutcome", () => {
  it("uses the last non-empty non-error payload as summary and output", () => {
    const result = resolveCronPayloadOutcome({
      payloads: [{ text: "first" }, { text: " " }, { text: " last " }],
    });

    expect(result.summary).toBe("last");
    expect(result.outputText).toBe("last");
    expect(result.hasFatalErrorPayload).toBe(false);
  });

  it("returns a fatal error from the last error payload when no success follows", () => {
    const result = resolveCronPayloadOutcome({
      payloads: [
        {
          text: "⚠️ 🛠️ Exec failed: /bin/bash: line 1: python: command not found",
          isError: true,
        },
      ],
    });

    expect(result.hasFatalErrorPayload).toBe(true);
    expect(result.embeddedRunError).toContain("command not found");
    expect(result.summary).toContain("Exec failed");
  });

  it("treats transient error payloads as non-fatal when a later success exists", () => {
    const result = resolveCronPayloadOutcome({
      payloads: [
        { text: "⚠️ ✍️ Write: failed", isError: true },
        { text: "Write completed successfully.", isError: false },
      ],
    });

    expect(result.hasFatalErrorPayload).toBe(false);
    expect(result.summary).toBe("Write completed successfully.");
  });

  it("keeps error payloads fatal when the run also reported a run-level error", () => {
    const result = resolveCronPayloadOutcome({
      payloads: [
        { text: "Model context overflow", isError: true },
        { text: "Partial assistant text before error" },
      ],
      runLevelError: { kind: "context_overflow", message: "exceeded context window" },
    });

    expect(result.hasFatalErrorPayload).toBe(true);
    expect(result.embeddedRunError).toContain("Model context overflow");
  });

  it("truncates long summaries", () => {
    const result = resolveCronPayloadOutcome({
      payloads: [{ text: "a".repeat(2001) }],
    });

    expect(result.summary ?? "").toMatch(/…$/);
  });

  it("preserves all successful deliverable payloads when no final assistant text is available", () => {
    const result = resolveCronPayloadOutcome({
      payloads: [
        { text: "line 1" },
        { text: "temporary error", isError: true },
        { text: "line 2" },
      ],
    });

    expect(result.deliveryPayloads).toEqual([{ text: "line 1" }, { text: "line 2" }]);
    expect(result.deliveryPayload).toEqual({ text: "line 2" });
  });

  it("prefers finalAssistantVisibleText for text-only announce delivery", () => {
    const result = resolveCronPayloadOutcome({
      payloads: [
        { text: "section 1" },
        { text: "temporary error", isError: true },
        { text: "section 2" },
      ],
      finalAssistantVisibleText: "section 1\nsection 2",
      preferFinalAssistantVisibleText: true,
    });

    expect(result.summary).toBe("section 1\nsection 2");
    expect(result.outputText).toBe("section 1\nsection 2");
    expect(result.synthesizedText).toBe("section 1\nsection 2");
    expect(result.deliveryPayloads).toEqual([{ text: "section 1\nsection 2" }]);
    expect(result.deliveryPayload).toEqual({ text: "section 2" });
  });

  it("keeps structured-content detection scoped to the last delivery payload", () => {
    const result = resolveCronPayloadOutcome({
      payloads: [{ mediaUrl: "https://example.com/report.png" }, { text: "final text" }],
      finalAssistantVisibleText: "full final report",
      preferFinalAssistantVisibleText: true,
    });

    expect(result.deliveryPayloads).toEqual([
      { mediaUrl: "https://example.com/report.png" },
      { text: "final text" },
    ]);
    expect(result.outputText).toBe("final text");
    expect(result.synthesizedText).toBe("final text");
    expect(result.deliveryPayloadHasStructuredContent).toBe(false);
  });

  it("returns only the last error payload when all payloads are errors", () => {
    const result = resolveCronPayloadOutcome({
      payloads: [
        { text: "first error", isError: true },
        { text: "last error", isError: true },
      ],
      finalAssistantVisibleText: "Recovered final answer",
      preferFinalAssistantVisibleText: true,
    });

    expect(result.outputText).toBe("last error");
    expect(result.deliveryPayloads).toEqual([{ text: "last error", isError: true }]);
    expect(result.deliveryPayload).toEqual({ text: "last error", isError: true });
  });

  it("keeps multi-payload direct delivery when finalAssistantVisibleText is not preferred", () => {
    const result = resolveCronPayloadOutcome({
      payloads: [{ text: "Working on it..." }, { text: "Final weather summary" }],
      finalAssistantVisibleText: "Final weather summary",
    });

    expect(result.outputText).toBe("Final weather summary");
    expect(result.deliveryPayloads).toEqual([
      { text: "Working on it..." },
      { text: "Final weather summary" },
    ]);
  });
});
