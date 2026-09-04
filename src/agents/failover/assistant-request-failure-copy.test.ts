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
      model: "claude-3-5-sonnet",
      status: 502,
    });
    expect(copy).toBe("⚠️ anthropic/claude-3-5-sonnet request failed (HTTP 502).");
  });

  it("returns undefined when only target is provided without reason or status", () => {
    const copy = renderAssistantRequestFailureCopy({
      provider: "anthropic",
      model: "claude-3-5-sonnet",
    });
    expect(copy).toBeUndefined();
  });

  it("returns undefined when reason is unclassified and status is absent", () => {
    const copy = renderAssistantRequestFailureCopy({
      provider: "openai",
      model: "gpt-4o",
      reason: "unclassified",
    });
    expect(copy).toBeUndefined();
  });

  it("returns undefined when reason is no_error_details and status is absent", () => {
    const copy = renderAssistantRequestFailureCopy({
      provider: "openai",
      model: "gpt-4o",
      reason: "no_error_details",
    });
    expect(copy).toBeUndefined();
  });
});
