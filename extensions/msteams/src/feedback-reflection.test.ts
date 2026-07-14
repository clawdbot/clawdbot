// Msteams tests cover feedback reflection plugin behavior.
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildReflectionPrompt, parseReflectionResponse } from "./feedback-reflection-prompt.js";
import { isReflectionAllowed, recordReflectionTime } from "./feedback-reflection-store.js";
import { buildFeedbackEvent } from "./feedback-reflection.js";

// Matches an unpaired UTF-16 surrogate (lone high or lone low), without relying
// on the ES2024 String.prototype.isWellFormed() runtime API.
const UNPAIRED_SURROGATE_RE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

describe("buildFeedbackEvent", () => {
  it("builds a well-formed custom event", () => {
    const event = buildFeedbackEvent({
      messageId: "msg-123",
      value: "negative",
      comment: "too verbose",
      sessionKey: "msteams:user1",
      agentId: "default",
      conversationId: "19:abc",
    });

    expect(event.type).toBe("custom");
    expect(event.event).toBe("feedback");
    expect(event.value).toBe("negative");
    expect(event.comment).toBe("too verbose");
    expect(event.messageId).toBe("msg-123");
    expect(event.ts).toBeGreaterThan(0);
  });

  it("omits comment when not provided", () => {
    const event = buildFeedbackEvent({
      messageId: "msg-123",
      value: "positive",
      sessionKey: "msteams:user1",
      agentId: "default",
      conversationId: "19:abc",
    });

    expect(event.comment).toBeUndefined();
    expect(event.value).toBe("positive");
  });
});

describe("buildReflectionPrompt", () => {
  it("includes the thumbed-down response", () => {
    const prompt = buildReflectionPrompt({
      thumbedDownResponse: "Here is a long explanation...",
    });

    expect(prompt).toContain("previous response wasn't helpful");
    expect(prompt).toContain("Here is a long explanation...");
    expect(prompt).toContain("reflect");
  });

  it("truncates long responses", () => {
    const longResponse = "x".repeat(600);
    const prompt = buildReflectionPrompt({
      thumbedDownResponse: longResponse,
    });

    expect(prompt).toContain("...");
    expect(prompt.length).toBeLessThan(longResponse.length + 500);
  });

  it("does not split UTF-16 surrogate pairs when truncating a thumbed-down response", () => {
    const thumbedDownResponse = `${"a".repeat(499)}🦞${"b".repeat(20)}`;

    const prompt = buildReflectionPrompt({ thumbedDownResponse });

    expect(prompt).not.toMatch(UNPAIRED_SURROGATE_RE);
    expect(prompt).toContain(`${"a".repeat(499)}...`);
    expect(prompt).not.toContain("\ud83e");
    expect(prompt).not.toContain("\udd9e");
  });

  it("keeps a boundary emoji when it fully fits before the truncation cap", () => {
    const thumbedDownResponse = `${"a".repeat(498)}🦞${"b".repeat(20)}`;

    const prompt = buildReflectionPrompt({ thumbedDownResponse });

    expect(prompt).not.toMatch(UNPAIRED_SURROGATE_RE);
    expect(prompt).toContain(`${"a".repeat(498)}🦞...`);
  });

  it("includes user comment when provided", () => {
    const prompt = buildReflectionPrompt({
      thumbedDownResponse: "Some response",
      userComment: "Too wordy",
    });

    expect(prompt).toContain('User\'s comment: "Too wordy"');
  });

  it("works without optional params", () => {
    const prompt = buildReflectionPrompt({});
    expect(prompt).toContain("previous response wasn't helpful");
    expect(prompt).toContain('"followUp":false');
  });
});

describe("parseReflectionResponse", () => {
  it("parses strict JSON output", () => {
    expect(
      parseReflectionResponse(
        '{"learning":"Be more direct next time.","followUp":true,"userMessage":"Sorry about that. I will keep it tighter."}',
      ),
    ).toEqual({
      learning: "Be more direct next time.",
      followUp: true,
      userMessage: "Sorry about that. I will keep it tighter.",
    });
  });

  it("parses JSON inside markdown fences", () => {
    expect(
      parseReflectionResponse(
        '```json\n{"learning":"Ask a clarifying question first.","followUp":false,"userMessage":""}\n```',
      ),
    ).toEqual({
      learning: "Ask a clarifying question first.",
      followUp: false,
      userMessage: undefined,
    });
  });

  it("falls back to internal-only learning when parsing fails", () => {
    expect(parseReflectionResponse("Be more concise.\nFollow up: yes.")).toEqual({
      learning: "Be more concise.\nFollow up: yes.",
      followUp: false,
    });
  });
});

describe("reflection cooldown", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("allows first reflection", () => {
    expect(isReflectionAllowed("session-first")).toBe(true);
  });

  it("blocks reflection within cooldown", () => {
    recordReflectionTime("session-blocked");
    expect(isReflectionAllowed("session-blocked", 60_000)).toBe(false);
  });

  it("allows reflection after cooldown expires", () => {
    vi.spyOn(Date, "now").mockReturnValue(0);
    recordReflectionTime("session-expired");
    vi.spyOn(Date, "now").mockReturnValue(2);
    expect(isReflectionAllowed("session-expired", 1)).toBe(true);
  });

  it("tracks sessions independently", () => {
    recordReflectionTime("session-tracked-1");
    expect(isReflectionAllowed("session-tracked-1", 60_000)).toBe(false);
    expect(isReflectionAllowed("session-tracked-2", 60_000)).toBe(true);
  });

  it("keeps longer custom cooldown entries during pruning", () => {
    vi.spyOn(Date, "now").mockReturnValue(0);
    recordReflectionTime("prune-target", 600_000);

    vi.spyOn(Date, "now").mockReturnValue(301_000);
    for (let index = 0; index <= 500; index += 1) {
      recordReflectionTime(`prune-session-${index}`, 600_000);
    }

    expect(isReflectionAllowed("prune-target", 600_000)).toBe(false);
  });
});
