import { describe, expect, it } from "vitest";
import { classifyAnthropicFailoverReason } from "./provider-failover.js";

describe("classifyAnthropicFailoverReason", () => {
  it.each([
    "You've hit your session limit \u00b7 resets 1:50pm (America/Buenos_Aires)",
    "You've hit your limit \u00b7 resets 9:40pm (Europe/Madrid)",
  ])("classifies Claude CLI subscription exhaustion as rate_limit: %s", (errorMessage) => {
    expect(
      classifyAnthropicFailoverReason({
        provider: "claude-cli",
        errorMessage,
      }),
    ).toBe("rate_limit");
  });

  it.each([undefined, "anthropic", "openai"])(
    "does not share Claude CLI prose with provider %s",
    (provider) => {
      expect(
        classifyAnthropicFailoverReason({
          provider,
          errorMessage: "You've hit your session limit \u00b7 resets 1:50pm (America/Buenos_Aires)",
        }),
      ).toBeUndefined();
    },
  );

  it("does not classify unrelated Claude CLI session limits", () => {
    expect(
      classifyAnthropicFailoverReason({
        provider: "claude-cli",
        errorMessage: "terminal session limit reached (50)",
      }),
    ).toBeUndefined();
  });
});
