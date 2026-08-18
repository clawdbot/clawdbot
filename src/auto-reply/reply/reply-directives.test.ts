// Regression tests for #41966: fenced MEDIA: tokens must surface a skip signal
// from parseReplyDirectives (pure, no logging). Operator warning is emitted only
// for accepted outbound delivery (see outbound payloads path), not from recovery
// normalize helpers that may parse the same text repeatedly.
import { describe, expect, it, vi } from "vitest";

const logWarn = vi.fn();
vi.mock("../../logger.js", () => ({
  logWarn: (msg: string) => logWarn(msg),
}));

import { normalizeReplyPayloadDirectives } from "./reply-delivery.js";
import { parseReplyDirectives } from "./reply-directives.js";

const FENCED = "Here's how to send media:\n```\nMEDIA:/home/user/screenshot.png\n```\nEnd.";

describe("parseReplyDirectives fenced MEDIA signal (#41966)", () => {
  it("flags mediaTokenSkippedInFence without logging, even across repeated parses", () => {
    logWarn.mockClear();
    // Simulate comparison/planning paths that parse the same payload multiple times.
    const a = parseReplyDirectives(FENCED);
    const b = parseReplyDirectives(FENCED);
    const c = parseReplyDirectives(FENCED);
    expect(a.mediaTokenSkippedInFence).toBe(true);
    expect(a.fencedSkippedMediaDirectives).toEqual([expect.stringMatching(/MEDIA:/)]);
    expect(b.mediaTokenSkippedInFence).toBe(true);
    expect(c.mediaTokenSkippedInFence).toBe(true);
    // The fenced token stays as visible text (contract unchanged) and is not delivered as media.
    expect(a.text).toContain("MEDIA:/home/user/screenshot.png");
    expect(a.mediaUrls).toBeUndefined();
    // Parsing must never warn — that is the accepted-delivery path's job.
    expect(logWarn).not.toHaveBeenCalled();
  });

  it("does not flag when the MEDIA token is outside a fence", () => {
    const parsed = parseReplyDirectives("MEDIA:https://example.com/image.png");
    expect(parsed.mediaTokenSkippedInFence).toBe(false);
  });

  it("does not flag when extractMediaDirectives is disabled", () => {
    const parsed = parseReplyDirectives(FENCED, { extractMediaDirectives: false });
    expect(parsed.mediaTokenSkippedInFence).toBe(false);
  });
});

describe("normalizeReplyPayloadDirectives stays silent for recovery paths (#41966)", () => {
  it("does not warn for a fenced MEDIA payload (not accepted delivery)", () => {
    logWarn.mockClear();
    normalizeReplyPayloadDirectives({ payload: { text: FENCED } });
    expect(logWarn).not.toHaveBeenCalled();
  });

  it("does not warn when there is no fenced MEDIA token", () => {
    logWarn.mockClear();
    normalizeReplyPayloadDirectives({ payload: { text: "just a normal reply" } });
    expect(logWarn).not.toHaveBeenCalled();
  });
});
