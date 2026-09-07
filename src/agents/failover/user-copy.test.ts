import { describe, expect, it } from "vitest";
import {
  HEARTBEAT_EXTERNAL_RUN_FAILURE_TEXT,
  renderFormatErrorCopy,
  renderBillingReplyCopy,
  renderCliTimeoutReplyCopy,
  renderFailoverCodeUserCopy,
  renderHeartbeatRunFailureCopy,
  renderMissingApiKeyReplyCopy,
  renderRateLimitOrOverloadedCopy,
  renderRateLimitReplyCopy,
} from "./user-copy.js";

describe("failover user copy", () => {
  it.each([
    [undefined, HEARTBEAT_EXTERNAL_RUN_FAILURE_TEXT],
    ["", HEARTBEAT_EXTERNAL_RUN_FAILURE_TEXT],
    [
      "Codex session became active in another runner; wait for it to finish before continuing",
      "⚠️ Heartbeat check failed before it could produce an update: Codex session became active in another runner; wait for it to finish before continuing. The main chat session remains available.",
    ],
    [
      "Codex session became active in another runner; wait for it to finish before continuing.",
      "⚠️ Heartbeat check failed before it could produce an update: Codex session became active in another runner; wait for it to finish before continuing. The main chat session remains available.",
    ],
  ])("renders heartbeat failure copy for %j", (reason, expected) => {
    expect(renderHeartbeatRunFailureCopy(reason)).toBe(expected);
  });

  const tokenLimitCopy =
    "LLM request rejected: configured maxTokens is 384000, above the provider maximum of 65536. Lower maxTokens and try again.";

  it("renders only the allowlisted selected-profile code", () => {
    expect(renderFailoverCodeUserCopy("selected_auth_profile_unavailable")).toBe(
      "The selected auth profile is unavailable in this agent's OpenClaw credential store. " +
        "Import or migrate that credential into the agent, select another configured profile, or run `openclaw configure`, then retry.",
    );
    expect(renderFailoverCodeUserCopy("plugin_selected_profile_unavailable")).toBeUndefined();
    expect(
      renderFailoverCodeUserCopy({ code: "selected_auth_profile_unavailable" }),
    ).toBeUndefined();
  });

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

  it.each([
    "Error: 400 max_tokens (384000) exceeds model's maximum output tokens (65536)",
    "OpenAI API error (400): max_output_tokens (384000) exceeds model's maximum output tokens (65536)",
    "Azure OpenAI API error (400): max_completion_tokens (384000) exceeds model's maximum output tokens (65536)",
    "OpenAI API error (400): 400 max_new_tokens (384000) exceeds model's maximum output tokens (65536)",
  ])("surfaces token limits from %s", (raw) => {
    expect(renderFormatErrorCopy(raw)).toBe(tokenLimitCopy);
  });

  it("keeps overlong provider-controlled limit text generic", () => {
    const raw = `400 max_tokens (384000) exceeds ${"x".repeat(301)} maximum output tokens (65536)`;
    expect(renderFormatErrorCopy(raw)).toBe(
      "LLM request failed: provider rejected the request schema or tool payload.",
    );
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
    expect(renderBillingReplyCopy({})).toBe(
      "⚠️ API provider returned a billing error — your API key has run out of credits or has an insufficient balance. Check your provider's billing dashboard and top up or switch to a different API key.",
    );
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

describe("rate limit copy from a failover chain summary", () => {
  const aggregate =
    "All models failed (3): anthropic/claude-opus-5: You've hit your session limit · resets 6:20pm (Europe/London) (unknown) | " +
    "claude-cli/claude-sonnet-5: You've hit your session limit · resets 6:20pm (Europe/London) (unknown) | " +
    "openai/gpt-5.6-sol: Codex error: The usage limit has been reached (rate_limit)";

  it("keeps the provider reset hint when the summary exceeds the length guard", () => {
    // The summary is over the 300 char bound, so reading it whole discards a hint the
    // provider did give. The first leg is the route the user picked.
    expect(aggregate.length).toBeGreaterThan(300);
    const copy = renderRateLimitOrOverloadedCopy({ reason: "rate_limit", raw: aggregate });
    expect(copy).toContain("resets 6:20pm (Europe/London)");
    expect(copy).not.toBe("⚠️ API rate limit reached. Please try again later.");
  });

  it("still falls back to the generic message when no leg carries a hint", () => {
    const copy = renderRateLimitOrOverloadedCopy({
      reason: "rate_limit",
      raw: "All models failed (2): anthropic/claude: 429 (rate_limit) | openai/gpt-5.4: 429 (rate_limit)",
    });
    expect(copy).toContain("API rate limit reached");
  });
});
