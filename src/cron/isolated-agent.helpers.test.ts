import { describe, expect, it } from "vitest";
import { detectCronDenialToken, resolveCronPayloadOutcome } from "./isolated-agent/helpers.js";

describe("detectCronDenialToken", () => {
  it("matches host denial markers case-sensitively", () => {
    expect(detectCronDenialToken("SYSTEM_RUN_DENIED: approval blocked")).toBe("SYSTEM_RUN_DENIED");
    expect(detectCronDenialToken("INVALID_REQUEST: denied")).toBe("INVALID_REQUEST");
    expect(detectCronDenialToken("system_run_denied: approval blocked")).toBeUndefined();
    expect(detectCronDenialToken("invalid_request: denied")).toBeUndefined();
  });

  it("matches model-narrated denial phrases case-insensitively", () => {
    expect(detectCronDenialToken("Approval Cannot Safely Bind this runtime command")).toBe(
      "approval cannot safely bind",
    );
    expect(detectCronDenialToken("The runtime denied the operation.")).toBe("runtime denied");
    expect(detectCronDenialToken("I could not run the script.")).toBe("could not run");
    expect(detectCronDenialToken("The command did not run to completion.")).toBe("did not run");
    expect(detectCronDenialToken("The request was denied by policy.")).toBe("was denied");
  });

  it("ignores empty and non-token text", () => {
    expect(detectCronDenialToken(undefined)).toBeUndefined();
    expect(
      detectCronDenialToken("The denied claim was reviewed, then the job succeeded."),
    ).toBeUndefined();
  });
});

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

  it("treats trailing message delivery warnings as non-fatal when final assistant text exists", () => {
    const result = resolveCronPayloadOutcome({
      payloads: [{ text: "Draft output" }, { text: "⚠️ ✉️ Message failed", isError: true }],
      finalAssistantVisibleText: "Final cron report",
      preferFinalAssistantVisibleText: true,
    });

    expect(result.hasFatalErrorPayload).toBe(false);
    expect(result.embeddedRunError).toBeUndefined();
    expect(result.pendingPresentationWarningError).toBe("⚠️ ✉️ Message failed");
    expect(result.summary).toBe("Final cron report");
    expect(result.outputText).toBe("Final cron report");
    expect(result.deliveryPayloads).toEqual([{ text: "Final cron report" }]);
  });

  it("keeps trailing canvas warnings fatal even when earlier assistant output exists", () => {
    const result = resolveCronPayloadOutcome({
      payloads: [{ text: "Saved report to disk." }, { text: "⚠️ 🖼️ Canvas failed", isError: true }],
    });

    expect(result.hasFatalErrorPayload).toBe(true);
    expect(result.pendingPresentationWarningError).toBeUndefined();
    expect(result.embeddedRunError).toBe("⚠️ 🖼️ Canvas failed");
    expect(result.deliveryPayloads).toEqual([{ text: "⚠️ 🖼️ Canvas failed", isError: true }]);
  });

  it("keeps standalone presentation warnings fatal when there is no cron output", () => {
    const result = resolveCronPayloadOutcome({
      payloads: [{ text: "⚠️ ✉️ Message failed", isError: true }],
    });

    expect(result.hasFatalErrorPayload).toBe(true);
    expect(result.embeddedRunError).toBe("⚠️ ✉️ Message failed");
    expect(result.deliveryPayloads).toEqual([{ text: "⚠️ ✉️ Message failed", isError: true }]);
  });

  it("keeps real trailing errors fatal even when earlier assistant output exists", () => {
    const result = resolveCronPayloadOutcome({
      payloads: [{ text: "Partial result" }, { text: "model provider unreachable", isError: true }],
      finalAssistantVisibleText: "Partial result",
      preferFinalAssistantVisibleText: true,
    });

    expect(result.hasFatalErrorPayload).toBe(true);
    expect(result.embeddedRunError).toBe("model provider unreachable");
    expect(result.outputText).toBe("model provider unreachable");
    expect(result.deliveryPayloads).toEqual([
      { text: "model provider unreachable", isError: true },
    ]);
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
    expect(result.outputText).toBe("Model context overflow");
    expect(result.deliveryPayloads).toEqual([{ text: "Model context overflow", isError: true }]);
  });

  it("treats standalone run-level errors as fatal and synthesizes delivery", () => {
    const result = resolveCronPayloadOutcome({
      payloads: [],
      runLevelError: { kind: "provider_error", message: "model provider unreachable" },
    });

    expect(result.hasFatalErrorPayload).toBe(true);
    expect(result.embeddedRunError).toBe("cron isolated run failed: model provider unreachable");
    expect(result.summary).toBe("cron isolated run failed: model provider unreachable");
    expect(result.outputText).toBe("cron isolated run failed: model provider unreachable");
    expect(result.synthesizedText).toBe("cron isolated run failed: model provider unreachable");
    expect(result.deliveryPayload).toEqual({
      text: "cron isolated run failed: model provider unreachable",
      isError: true,
    });
    expect(result.deliveryPayloads).toEqual([
      { text: "cron isolated run failed: model provider unreachable", isError: true },
    ]);
    expect(result.deliveryPayloadHasStructuredContent).toBe(false);
  });

  it("uses string run-level errors when no error payload exists", () => {
    const result = resolveCronPayloadOutcome({
      payloads: [{ text: " " }],
      runLevelError: "rate limit exceeded",
    });

    expect(result.hasFatalErrorPayload).toBe(true);
    expect(result.embeddedRunError).toBe("cron isolated run failed: rate limit exceeded");
    expect(result.deliveryPayloads).toEqual([
      { text: "cron isolated run failed: rate limit exceeded", isError: true },
    ]);
  });

  it("falls back to run-level error kind without exposing arbitrary objects", () => {
    const result = resolveCronPayloadOutcome({
      payloads: [{ text: "Partial assistant text before failure" }],
      runLevelError: { kind: "retry_limit", detail: { provider: "example" } },
    });

    expect(result.hasFatalErrorPayload).toBe(true);
    expect(result.embeddedRunError).toBe("cron isolated run failed: retry_limit");
    expect(result.outputText).toBe("cron isolated run failed: retry_limit");
    expect(result.deliveryPayloads).toEqual([
      { text: "cron isolated run failed: retry_limit", isError: true },
    ]);
  });

  it("uses a generic run-level error for unrecognized objects", () => {
    const result = resolveCronPayloadOutcome({
      payloads: [],
      runLevelError: { detail: { provider: "example" } },
    });

    expect(result.hasFatalErrorPayload).toBe(true);
    expect(result.embeddedRunError).toBe("cron isolated run failed");
    expect(result.deliveryPayloads).toEqual([{ text: "cron isolated run failed", isError: true }]);
  });

  it("does not let later success clear a run-level error", () => {
    const result = resolveCronPayloadOutcome({
      payloads: [
        { text: "Temporary provider failure", isError: true },
        { text: "Partial success-looking text" },
      ],
      runLevelError: "retry limit exceeded",
    });

    expect(result.hasFatalErrorPayload).toBe(true);
    expect(result.embeddedRunError).toBe("Temporary provider failure");
    expect(result.outputText).toBe("Temporary provider failure");
    expect(result.deliveryPayloads).toEqual([
      { text: "Temporary provider failure", isError: true },
    ]);
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

  it("keeps presentation-only delivery payloads instead of collapsing to final text", () => {
    const presentationPayload = {
      presentation: {
        blocks: [{ type: "buttons" as const, buttons: [{ label: "Open", value: "open" }] }],
      },
    };
    const result = resolveCronPayloadOutcome({
      payloads: [presentationPayload],
      finalAssistantVisibleText: "fallback text",
      preferFinalAssistantVisibleText: true,
    });

    expect(result.deliveryPayloads).toEqual([presentationPayload]);
    expect(result.deliveryPayload).toEqual(presentationPayload);
    expect(result.outputText).toBeUndefined();
    expect(result.synthesizedText).toBeUndefined();
    expect(result.deliveryPayloadHasStructuredContent).toBe(true);
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

  it("promotes narrated denial markers in summary text to fatal errors", () => {
    const result = resolveCronPayloadOutcome({
      payloads: [
        {
          text: "SYSTEM_RUN_DENIED: approval cannot safely bind this interpreter/runtime command",
        },
      ],
    });

    expect(result.hasFatalErrorPayload).toBe(true);
    expect(result.embeddedRunError).toBe(
      'cron classifier: denial token "SYSTEM_RUN_DENIED" detected in summary',
    );
  });

  it("promotes narrated denial markers from final assistant visible text", () => {
    const result = resolveCronPayloadOutcome({
      payloads: [{ text: "Working on it..." }],
      finalAssistantVisibleText: "I could not run the requested script.",
      preferFinalAssistantVisibleText: true,
    });

    expect(result.hasFatalErrorPayload).toBe(true);
    expect(result.outputText).toBe("I could not run the requested script.");
    expect(result.embeddedRunError).toBe(
      'cron classifier: denial token "could not run" detected in summary',
    );
  });

  it("prefers typed failure signals over denial-token fallback", () => {
    const result = resolveCronPayloadOutcome({
      payloads: [{ text: "On it, retrying now." }],
      failureSignal: {
        kind: "execution_denied",
        source: "tool",
        toolName: "exec",
        code: "SYSTEM_RUN_DENIED",
        message: "SYSTEM_RUN_DENIED: approval required",
        fatalForCron: true,
      },
    });

    expect(result.hasFatalErrorPayload).toBe(true);
    expect(result.embeddedRunError).toBe(
      "cron classifier: execution_denied failure from exec (SYSTEM_RUN_DENIED): SYSTEM_RUN_DENIED: approval required",
    );
    expect(result.summary).toBe("SYSTEM_RUN_DENIED: approval required");
    expect(result.outputText).toBe("SYSTEM_RUN_DENIED: approval required");
    expect(result.synthesizedText).toBe("SYSTEM_RUN_DENIED: approval required");
    expect(result.deliveryPayload).toEqual({
      text: "SYSTEM_RUN_DENIED: approval required",
      isError: true,
    });
    expect(result.deliveryPayloads).toEqual([
      { text: "SYSTEM_RUN_DENIED: approval required", isError: true },
    ]);
    expect(result.deliveryPayloadHasStructuredContent).toBe(false);
  });

  it("ignores non-fatal failure signal metadata", () => {
    const result = resolveCronPayloadOutcome({
      payloads: [{ text: "ordinary success" }],
      failureSignal: {
        kind: "execution_denied",
        source: "tool",
        message: "SYSTEM_RUN_DENIED: approval required",
        fatalForCron: false,
      },
    });

    expect(result.hasFatalErrorPayload).toBe(false);
    expect(result.embeddedRunError).toBeUndefined();
  });

  it("keeps structured error payload reasons ahead of denial-token reasons", () => {
    const result = resolveCronPayloadOutcome({
      payloads: [
        {
          text: "Exec failed before SYSTEM_RUN_DENIED could be retried",
          isError: true,
        },
      ],
    });

    expect(result.hasFatalErrorPayload).toBe(true);
    expect(result.embeddedRunError).toBe("Exec failed before SYSTEM_RUN_DENIED could be retried");
  });
});
