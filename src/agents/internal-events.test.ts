import { describe, expect, it } from "vitest";
import { annotateInterSessionPromptText } from "../sessions/input-provenance.js";
import {
  buildAgentInternalEventContext,
  buildGeneratedMediaDeliveryContext,
  formatAgentInternalEventsForPrompt,
  type AgentInternalEvent,
  prependInternalEventContext,
  resolveAcpPromptBody,
  resolveInternalEventPromptBody,
  resolveInternalEventTranscriptBody,
} from "./internal-events.js";
import {
  INTERNAL_RUNTIME_CONTEXT_BEGIN,
  INTERNAL_RUNTIME_CONTEXT_END,
} from "./internal-runtime-context.js";

const MAX_CHILD_RESULT_CHARS = 6_000;
const CHILD_RESULT_TRUNCATION_NOTICE = "\n[child result truncated]";
const MAX_STATUS_LABEL_CHARS = 500;
const STATUS_LABEL_TRUNCATION_MARKER = "…[truncated]";

function taskCompletionEvent(result: string): AgentInternalEvent {
  return {
    type: "task_completion",
    source: "subagent",
    childSessionKey: "agent:main:subagent:test",
    childSessionId: "child-session-id",
    announceType: "subagent task",
    taskLabel: "Inspect output",
    status: "ok",
    statusLabel: "completed; ready for parent review",
    result,
    replyInstruction: "Review the result.",
  };
}

function extractStatusLine(prompt: string): string {
  const status = prompt.match(/^status: (.*)$/m)?.[1];
  if (status === undefined) {
    throw new Error("Expected status line");
  }
  return status;
}

function extractChildResult(prompt: string): string {
  const result = prompt.match(/<prompt-data>\n([\s\S]*?)\n<\/prompt-data>/)?.[1];
  if (result === undefined) {
    throw new Error("Expected child result data block");
  }
  return result;
}

describe("agent internal events", () => {
  it("keeps child output and task labels in data while retaining the producer instruction", () => {
    const event = taskCompletionEvent("The measured value is < 5.");
    const fragments = buildAgentInternalEventContext([event]);
    const instructions = fragments
      .filter((fragment) => fragment.kind === "runtime-instruction")
      .map((fragment) => fragment.text)
      .join("\n");
    const data = fragments
      .filter((fragment) => fragment.kind === "conversation-data")
      .map((fragment) => fragment.text)
      .join("\n");
    expect(instructions).toContain(event.replyInstruction);
    expect(instructions).not.toContain(event.result);
    expect(instructions).not.toContain(event.taskLabel);
    expect(data).toContain(event.result);
    expect(data).toContain(event.taskLabel);
    expect(event.result).toBe("The measured value is < 5.");
  });

  it("rebuilds media retry instructions separately from the retained media references", () => {
    const media = ["https://example.test/report.png"];
    const fragments = buildGeneratedMediaDeliveryContext(media, true);
    expect(fragments.find((fragment) => fragment.kind === "runtime-instruction")?.text).toContain(
      "Do not resend any other attachment.",
    );
    expect(fragments.find((fragment) => fragment.kind === "conversation-data")?.text).toBe(
      "Generated media:\nMEDIA:https://example.test/report.png",
    );
    expect(media).toEqual(["https://example.test/report.png"]);
  });

  it("bounds protected and plain child-result projections after escaping", () => {
    const fullResult = `${"<".repeat(MAX_CHILD_RESULT_CHARS)}-unbounded-tail`;
    const event = taskCompletionEvent(fullResult);
    const protectedResult = extractChildResult(formatAgentInternalEventsForPrompt([event]));
    const plainResult = extractChildResult(resolveAcpPromptBody("", [event]));

    expect(protectedResult).toBe(plainResult);
    expect(protectedResult.length).toBeLessThanOrEqual(MAX_CHILD_RESULT_CHARS);
    expect(protectedResult.endsWith(CHILD_RESULT_TRUNCATION_NOTICE)).toBe(true);
    expect(protectedResult).not.toContain("unbounded-tail");
    expect(event.result).toBe(fullResult);
  });

  it("keeps ordinary child results unchanged", () => {
    const result = "small useful result";

    expect(
      extractChildResult(formatAgentInternalEventsForPrompt([taskCompletionEvent(result)])),
    ).toBe(result);
  });

  it("keeps a bounded route change separate from child result text", () => {
    const event = {
      ...taskCompletionEvent("child result"),
      modelRouteChange: "Model route changed: requested/model → actual/model.",
    } satisfies AgentInternalEvent;
    const prompt = formatAgentInternalEventsForPrompt([event]);

    expect(extractChildResult(prompt)).toBe("child result");
    expect(prompt).toContain(event.modelRouteChange);
  });

  it("bounds status labels carrying caller-supplied error text", () => {
    const event = {
      ...taskCompletionEvent("result"),
      status: "timeout",
      statusLabel: `timed out: ${"e".repeat(MAX_STATUS_LABEL_CHARS)}-unbounded-tail`,
    } satisfies AgentInternalEvent;
    const status = extractStatusLine(formatAgentInternalEventsForPrompt([event]));

    expect(status.length).toBeLessThanOrEqual(MAX_STATUS_LABEL_CHARS);
    expect(status.endsWith(STATUS_LABEL_TRUNCATION_MARKER)).toBe(true);
    expect(status).not.toContain("unbounded-tail");
    expect(status.startsWith("timed out: ")).toBe(true);
  });

  it("never splits a surrogate pair when truncating a status label", () => {
    // Land an astral character exactly on the truncation boundary.
    const marker = STATUS_LABEL_TRUNCATION_MARKER;
    const keep = MAX_STATUS_LABEL_CHARS - marker.length;
    const event = {
      ...taskCompletionEvent("result"),
      status: "timeout",
      statusLabel: `${"a".repeat(keep - 1)}\u{1F600}${"b".repeat(50)}`,
    } satisfies AgentInternalEvent;
    const status = extractStatusLine(formatAgentInternalEventsForPrompt([event]));

    expect(status.length).toBeLessThanOrEqual(MAX_STATUS_LABEL_CHARS);
    expect(status.endsWith(marker)).toBe(true);
    const truncated = status.slice(0, -marker.length);
    // A dangling high surrogate would make this false.
    expect(truncated).toBe(truncated.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, ""));
    expect(truncated.includes("\uFFFD")).toBe(false);
  });

  it("keeps ordinary status labels unchanged", () => {
    const event = {
      ...taskCompletionEvent("result"),
      status: "error",
      statusLabel: "failed: model returned no output",
    } satisfies AgentInternalEvent;

    expect(extractStatusLine(formatAgentInternalEventsForPrompt([event]))).toBe(
      "failed: model returned no output",
    );
  });
});

describe("attempt execution prompt materialization", () => {
  it("materializes ACP internal events without OpenClaw internal runtime markers", () => {
    const events = [taskCompletionEvent("child result")];
    const body = `${formatAgentInternalEventsForPrompt(events)}\n\nvisible follow-up`;

    const prompt = resolveAcpPromptBody(body, events);

    // ACP receives visible event text, while private runtime envelopes stay out
    // of the model-facing prompt.
    expect(prompt).toContain("A background task completed.");
    expect(prompt).toContain("Inspect output");
    expect(prompt).toContain("child result");
    expect(prompt).toContain("visible follow-up");
    expect(prompt).not.toContain(INTERNAL_RUNTIME_CONTEXT_BEGIN);
    expect(prompt).not.toContain(INTERNAL_RUNTIME_CONTEXT_END);
  });

  it("keeps ordinary ACP prompt text unchanged when no internal event is present", () => {
    expect(resolveAcpPromptBody("plain user prompt", undefined)).toBe("plain user prompt");
  });

  it("uses plain event text for transcripts when the trigger message is an internal envelope", () => {
    const events = [taskCompletionEvent("child result")];
    const transcriptBody = resolveInternalEventTranscriptBody(
      formatAgentInternalEventsForPrompt(events),
      events,
    );

    expect(transcriptBody).toContain("A background task completed.");
    expect(transcriptBody).toContain("Inspect output");
    expect(transcriptBody).not.toContain(INTERNAL_RUNTIME_CONTEXT_BEGIN);
    expect(transcriptBody).not.toContain(INTERNAL_RUNTIME_CONTEXT_END);
  });

  it("removes only the typed producer's duplicate carrier and retains supplemental text", () => {
    const events = [taskCompletionEvent("child result")];
    const carrier = formatAgentInternalEventsForPrompt(events);
    expect(prependInternalEventContext(carrier, events)).toBe(carrier);
    expect(prependInternalEventContext("Follow up.", events)).toBe(`${carrier}\n\nFollow up.`);
    expect(resolveInternalEventPromptBody(`${carrier}\n\nFollow up.`, events)).toBe("Follow up.");
    expect(resolveInternalEventPromptBody(carrier, undefined)).toBe(carrier);
    expect(resolveInternalEventTranscriptBody(carrier, undefined)).toBe(carrier);
    const provenance = { kind: "inter_session", sourceTool: "subagent_announce" } as const;
    const annotated = annotateInterSessionPromptText(`${carrier}\n\nFollow up.`, provenance);
    expect(prependInternalEventContext(annotated, events, provenance)).toBe(annotated);
    expect(resolveInternalEventPromptBody(annotated, events, provenance)).toBe("Follow up.");
    expect(resolveInternalEventPromptBody(annotated, undefined, provenance)).toBe(annotated);
    for (const render of [resolveAcpPromptBody, resolveInternalEventTranscriptBody]) {
      const plain = render(annotated, events, provenance);
      expect(plain).not.toContain(INTERNAL_RUNTIME_CONTEXT_BEGIN);
      expect(plain).not.toContain(INTERNAL_RUNTIME_CONTEXT_END);
      expect(plain.split("child result")).toHaveLength(2);
      expect(plain).toContain("sourceTool=subagent_announce isUser=false");
      expect(plain.endsWith("Follow up.")).toBe(true);
    }
  });
});
