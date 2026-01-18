import { describe, expect, it } from "vitest";

import { buildMessagingTarget, ensureTargetId, requireTargetKind } from "./targets.js";

describe("ensureTargetId", () => {
  it("returns the candidate when it matches", () => {
    expect(
      ensureTargetId({
        candidate: "U123",
        pattern: /^[A-Z0-9]+$/i,
        errorMessage: "bad",
      }),
    ).toBe("U123");
  });

  it("throws with the provided message on mismatch", () => {
    expect(() =>
      ensureTargetId({
        candidate: "not-ok",
        pattern: /^[A-Z0-9]+$/i,
        errorMessage: "Bad target",
      }),
    ).toThrow(/Bad target/);
  });
});

describe("requireTargetKind", () => {
  it("returns the target id when the kind matches", () => {
    const target = buildMessagingTarget("channel", "C123", "C123");
    expect(requireTargetKind({ platform: "Slack", target, kind: "channel" })).toBe("C123");
  });

  it("throws when the kind is missing or mismatched", () => {
    expect(() =>
      requireTargetKind({ platform: "Slack", target: undefined, kind: "channel" }),
    ).toThrow(/Slack channel id is required/);
    const target = buildMessagingTarget("user", "U123", "U123");
    expect(() => requireTargetKind({ platform: "Slack", target, kind: "channel" })).toThrow(
      /Slack channel id is required/,
    );
  });
});
