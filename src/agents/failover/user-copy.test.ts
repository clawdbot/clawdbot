import { describe, expect, it } from "vitest";
import {
  BILLING_ERROR_USER_MESSAGE,
  renderBillingReplyCopy,
  renderCliTimeoutReplyCopy,
  renderMissingApiKeyReplyCopy,
  renderRateLimitOrOverloadedCopy,
  renderRateLimitReplyCopy,
} from "./user-copy.js";

describe("failover user copy", () => {
  it("renders transient copy from the classified reason", () => {
    const raw = "429 Too Many Requests: model overloaded";
    expect(renderRateLimitOrOverloadedCopy({ reason: "rate_limit", raw })).toBe(
      "⚠️ API rate limit reached. Please try again later.",
    );
    expect(renderRateLimitOrOverloadedCopy({ reason: "overloaded", raw })).toBe(
      "The AI service is temporarily overloaded. Please try again in a moment.",
    );
  });

  it("preserves actionable provider retry detail for classified rate limits", () => {
    expect(
      renderRateLimitOrOverloadedCopy({
        reason: "rate_limit",
        raw: "429 rate limit: service overloaded, try again in 30 seconds",
      }),
    ).toBe("⚠️ rate limit: service overloaded, try again in 30 seconds");
  });

  it("renders structured cooldown durations and exhausted model sets", () => {
    const now = 1_000_000;
    expect(
      renderRateLimitReplyCopy({
        message: "limited",
        reason: "rate_limit",
        attempts: [{ provider: "openai", model: "gpt-a", reason: "rate_limit" }],
        cooldownExpiry: now + 45_000,
        nowMs: now,
      }),
    ).toBe("⚠️ Rate-limited — ready in ~45s. Please wait a moment.");
    expect(
      renderRateLimitReplyCopy({
        message: "limited",
        reason: "rate_limit",
        attempts: [
          { provider: "openai", model: "gpt-a", reason: "rate_limit" },
          { provider: "anthropic", model: "claude-b", reason: "overloaded" },
        ],
        nowMs: now,
      }),
    ).toBe(
      "⚠️ All attempted models were rate-limited or overloaded. Please try again in a few minutes.",
    );
  });

  it("uses neutral billing copy for subscription credentials", () => {
    expect(
      renderBillingReplyCopy({
        provider: "Anthropic",
        model: "claude",
        authMode: "oauth",
      }),
    ).toBe(
      "⚠️ Anthropic (claude) returned a billing error — check your account for subscription or usage limits, then try again.",
    );
    expect(renderBillingReplyCopy({})).toBe(BILLING_ERROR_USER_MESSAGE);
  });

  it("renders provider-safe missing-key guidance", () => {
    expect(renderMissingApiKeyReplyCopy({ provider: "openai", providerGuidance: true })).toContain(
      "Missing API key for OpenAI on the gateway",
    );
    expect(renderMissingApiKeyReplyCopy({ provider: "provider-with-secret-name" })).toBe(
      "⚠️ Missing API key for the selected provider on the gateway. Configure provider auth, then try again.",
    );
  });

  it("renders typed CLI timeout context without losing partial-work warnings", () => {
    expect(
      renderCliTimeoutReplyCopy({
        message: "openai/gpt-5.6-sol: CLI exceeded timeout (90s) and was terminated",
        provider: "codex-cli",
        cliTimeout: {
          mode: "overall",
          timeoutSeconds: 90,
          observedActivity: true,
          activeToolCount: 1,
          backgroundTaskCount: 2,
        },
        replayPrevented: true,
      }),
    ).toBe(
      "⚠️ CLI turn (routing openai/gpt-5.6-sol): timed out after 90s (overall turn limit). The gateway is unaffected. It also stopped 2 CLI background tasks and 1 active CLI tool call; that work shares the parent CLI process. Effects may be partial; check before retrying. OpenClaw did not replay this turn automatically. For long work, use a detached OpenClaw sub-agent (no run timeout by default), or raise `agents.defaults.timeoutSeconds`.",
    );
  });
});
