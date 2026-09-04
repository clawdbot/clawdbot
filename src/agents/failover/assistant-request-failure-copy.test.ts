import { describe, expect, it } from "vitest";
import { renderAssistantRequestFailureCopy } from "./assistant-request-failure-copy.js";

describe("renderAssistantRequestFailureCopy", () => {
  it("renders provider and reason when classified", () => {
    const copy = renderAssistantRequestFailureCopy({
      provider: "openai",
      model: "gpt-5.6-luna",
      reason: "rate_limit",
    });
    expect(copy).toBe(
      "⚠️ openai/gpt-5.6-luna request failed (rate limited). This is usually temporary — try again shortly.",
    );
  });

  it("renders HTTP status when status is provided without reason", () => {
    const copy = renderAssistantRequestFailureCopy({
      provider: "anthropic",
      model: "sonnet-4.6",
      status: 502,
    });
    expect(copy).toBe("⚠️ anthropic/sonnet-4.6 request failed (HTTP 502).");
  });

  it.each([undefined, "unclassified", "no_error_details"] as const)(
    "retains provider attribution for an opaque %s failure",
    (reason) => {
      const copy = renderAssistantRequestFailureCopy({
        provider: "anthropic",
        model: "sonnet-4.6",
        reason,
      });
      expect(copy).toBe("⚠️ anthropic/sonnet-4.6 request failed.");
    },
  );

  it("returns undefined without a target, reason, or status", () => {
    expect(renderAssistantRequestFailureCopy({})).toBeUndefined();
  });
});
