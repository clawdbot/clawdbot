import { describe, expect, it } from "vitest";
import { normalizeReplyPayload, type NormalizeReplySkipReason } from "./normalize-reply.js";

function collectSkip(reasons: NormalizeReplySkipReason[]) {
  return (reason: NormalizeReplySkipReason) => {
    reasons.push(reason);
  };
}

describe("normalizeReplyPayload CoT-frame suppression", () => {
  it("suppresses bare internal frames as silent", () => {
    const reasons: NormalizeReplySkipReason[] = [];
    const result = normalizeReplyPayload(
      { text: "[internal] thinking out loud" },
      { onSkip: collectSkip(reasons) },
    );
    expect(result).toBeNull();
    expect(reasons).toEqual(["silent"]);
  });

  it("suppresses reasoning frames as silent", () => {
    const reasons: NormalizeReplySkipReason[] = [];
    const result = normalizeReplyPayload(
      { text: "[reasoning] private plan" },
      { onSkip: collectSkip(reasons) },
    );
    expect(result).toBeNull();
    expect(reasons).toEqual(["silent"]);
  });

  it("suppresses scratchpad frames as silent", () => {
    const reasons: NormalizeReplySkipReason[] = [];
    const result = normalizeReplyPayload(
      { text: "[scratchpad - notes] private narration" },
      { onSkip: collectSkip(reasons) },
    );
    expect(result).toBeNull();
    expect(reasons).toEqual(["silent"]);
  });

  it("suppresses chain-of-thought frames as silent", () => {
    const reasons: NormalizeReplySkipReason[] = [];
    const result = normalizeReplyPayload(
      { text: "[chain of thought] hidden narration" },
      { onSkip: collectSkip(reasons) },
    );
    expect(result).toBeNull();
    expect(reasons).toEqual(["silent"]);
  });

  it("suppresses mixed-case frames as silent", () => {
    const reasons: NormalizeReplySkipReason[] = [];
    const result = normalizeReplyPayload(
      { text: "[INTERNAL] thinking" },
      { onSkip: collectSkip(reasons) },
    );
    expect(result).toBeNull();
    expect(reasons).toEqual(["silent"]);
  });

  it("suppresses zero-whitespace frames like [internal]leak as silent", () => {
    const reasons: NormalizeReplySkipReason[] = [];
    const result = normalizeReplyPayload(
      { text: "[internal]leak" },
      { onSkip: collectSkip(reasons) },
    );
    expect(result).toBeNull();
    expect(reasons).toEqual(["silent"]);
  });

  it("drops CoT-leaked text but keeps media when media is present", () => {
    const result = normalizeReplyPayload({
      text: "[internal] thinking out loud",
      mediaUrl: "https://example.com/img.png",
    });
    expect(result).not.toBeNull();
    expect(result!.text).toBe("");
    expect(result!.mediaUrl).toBe("https://example.com/img.png");
  });

  it("suppresses error-flagged CoT-frame payloads as silent too", () => {
    const reasons: NormalizeReplySkipReason[] = [];
    const result = normalizeReplyPayload(
      { text: "[internal] error narration", isError: true },
      { onSkip: collectSkip(reasons) },
    );
    expect(result).toBeNull();
    expect(reasons).toEqual(["silent"]);
  });

  it("passes through a normal user reply unchanged", () => {
    const result = normalizeReplyPayload({ text: "Normal user reply" });
    expect(result).not.toBeNull();
    expect(result!.text).toBe("Normal user reply");
  });

  it("passes through body-pure replies starting with punctuation", () => {
    const result = normalizeReplyPayload({ text: "* body-pure reply" });
    expect(result).not.toBeNull();
    expect(result!.text).toBe("* body-pure reply");
  });

  it("passes through [user] / [system] / [assistant] role labels", () => {
    const userResult = normalizeReplyPayload({ text: "[user] reported a bug" });
    expect(userResult).not.toBeNull();
    expect(userResult!.text).toBe("[user] reported a bug");

    const systemResult = normalizeReplyPayload({ text: "[system] ready" });
    expect(systemResult).not.toBeNull();
    expect(systemResult!.text).toBe("[system] ready");

    const assistantResult = normalizeReplyPayload({ text: "[assistant] replied" });
    expect(assistantResult).not.toBeNull();
    expect(assistantResult!.text).toBe("[assistant] replied");
  });

  it("passes through frames that are not at the start", () => {
    const result = normalizeReplyPayload({ text: "Some text [internal] not-at-start" });
    expect(result).not.toBeNull();
    expect(result!.text).toBe("Some text [internal] not-at-start");
  });
});
