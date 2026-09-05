import { describe, expect, it } from "vitest";
import { renderAssistantRequestFailureCopy } from "./assistant-request-failure-copy.js";

describe("renderAssistantRequestFailureCopy", () => {
  const target = { provider: "openai", model: "test-model" };

  it.each([undefined, null, "unclassified", "unknown"] as const)(
    "defers to neutral fallback for unclassified reason %s",
    (reason) => {
      // Harness-internal failures must not name the provider/model even when a
      // target is present — the provider was never contacted. See #137845.
      expect(renderAssistantRequestFailureCopy({ ...target, reason })).toBeUndefined();
      expect(renderAssistantRequestFailureCopy({ reason })).toBeUndefined();
    },
  );

  it.each(["empty_response", "no_error_details"] as const)(
    "retains provider attribution for the recognized %s terminal",
    (reason) => {
      expect(renderAssistantRequestFailureCopy({ ...target, reason })).toBe(
        "⚠️ openai/test-model request failed.",
      );
      expect(renderAssistantRequestFailureCopy({ reason })).toBeUndefined();
    },
  );

  it.each([
    [{ provider: "openai" }, undefined],
    [{ model: "test-model" }, undefined],
    [{}, undefined],
  ] as const)("defers partial model context %j to neutral fallback", (facts, expected) => {
    expect(renderAssistantRequestFailureCopy(facts)).toBe(expected);
  });

  it("requires a valid HTTP status before asserting a request failure", () => {
    expect(renderAssistantRequestFailureCopy({ ...target, status: 0 })).toBeUndefined();
    expect(renderAssistantRequestFailureCopy({ ...target, status: 400 })).toBe(
      "⚠️ openai/test-model request failed (HTTP 400).",
    );
  });

  it("retains classified guidance without an HTTP status", () => {
    expect(renderAssistantRequestFailureCopy({ ...target, reason: "auth" })).toBe(
      "⚠️ openai/test-model request failed (authentication failed). Re-authenticate the provider and try again.",
    );
  });

  it("does not name the provider for a harness-internal error with a populated target", () => {
    // Mirrors #137845: a session-store error like
    // SessionTranscriptProjectionUnavailableError synthesizes a failure message
    // that still carries the turn's active provider/model. The renderer must
    // defer to the neutral fallback instead of attributing the failure to the
    // provider that was never contacted.
    expect(
      renderAssistantRequestFailureCopy({
        provider: "openai",
        model: "gpt-5",
        reason: null,
        status: undefined,
      }),
    ).toBeUndefined();
  });
});
