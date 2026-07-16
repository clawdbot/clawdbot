import { describe, expect, it } from "vitest";
import { OAuthRefreshFailureError } from "../../agents/auth-profiles/oauth-refresh-failure.js";
import { FailoverError } from "../../agents/failover-error.js";
import { MissingProviderAuthError } from "../../agents/model-auth.js";
import type { TemplateContext } from "../templating.js";
import {
  setupAgentRunnerExecutionTestState,
  getRunAgentTurnWithFallback,
  createMockTypingSignaler,
  createFollowupRun,
  createMinimalRunAgentTurnParams,
} from "./agent-runner-execution.test-support.js";

const state = setupAgentRunnerExecutionTestState();

describe("runAgentTurnWithFallback: authentication failures", () => {
  it("surfaces gateway reauth guidance for known OAuth refresh failures", async () => {
    state.runEmbeddedAgentMock.mockRejectedValueOnce(
      new Error(
        "OAuth token refresh failed for openai: refresh_token_reused. Please try again or re-authenticate.",
      ),
    );

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const result = await runAgentTurnWithFallback({
      commandBody: "hello",
      followupRun: createFollowupRun(),
      sessionCtx: {
        Provider: "whatsapp",
        MessageSid: "msg",
      } as unknown as TemplateContext,
      opts: {},
      typingSignals: createMockTypingSignaler(),
      blockReplyPipeline: null,
      blockStreamingEnabled: false,
      resolvedBlockStreamingBreak: "message_end",
      applyReplyToMode: (payload) => payload,
      shouldEmitToolResult: () => true,
      shouldEmitToolOutput: () => false,
      pendingToolTasks: new Set(),
      resetSessionAfterRoleOrderingConflict: async () => false,
      isHeartbeat: false,
      sessionKey: "main",
      getActiveSessionEntry: () => undefined,
      resolvedVerboseLevel: "off",
    });

    expect(result.kind).toBe("final");
    if (result.kind === "final") {
      expect(result.payload.text).toBe(
        "⚠️ Model login expired on the gateway for openai. Send `/login codex` from a private chat or Web UI session to pair a new Codex login, or re-auth with `openclaw models auth login --provider openai` in a terminal, then try again.",
      );
    }
  });

  it("surfaces gateway reauth guidance from typed OAuth refresh failures", async () => {
    state.runEmbeddedAgentMock.mockRejectedValueOnce(
      new OAuthRefreshFailureError({
        provider: "openai",
        profileId: "openai:user@example.com",
        message: "invalid_grant",
      }),
    );

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const result = await runAgentTurnWithFallback(createMinimalRunAgentTurnParams());

    expect(result.kind).toBe("final");
    if (result.kind === "final") {
      expect(result.payload.text).toBe(
        "⚠️ Model login expired on the gateway for openai. Send `/login codex` from a private chat or Web UI session to pair a new Codex login, or re-auth with `openclaw models auth login --provider openai --profile-id 'openai:user@example.com'` in a terminal, then try again.",
      );
    }
  });

  it("preserves OAuth profile guidance through failover wrappers", async () => {
    const refreshError = new OAuthRefreshFailureError({
      provider: "openai",
      profileId: "openai:user@example.com",
      message: "invalid_grant",
    });
    state.runEmbeddedAgentMock.mockRejectedValueOnce(
      new FailoverError("OpenAI OAuth failed", {
        reason: "auth",
        provider: "openai",
        model: "gpt-5.5",
        profileId: "openai:user@example.com",
        authProfileFailure: { allInCooldown: false },
        status: 401,
        cause: refreshError,
      }),
    );

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const result = await runAgentTurnWithFallback(createMinimalRunAgentTurnParams());

    expect(result.kind).toBe("final");
    if (result.kind === "final") {
      expect(result.payload.text).toContain("--profile-id 'openai:user@example.com'");
    }
  });

  it("preserves OAuth profile guidance through fallback summaries", async () => {
    const refreshError = new OAuthRefreshFailureError({
      provider: "openai",
      profileId: "openai:user@example.com",
      message: "invalid_grant",
    });
    const failoverError = new FailoverError("OpenAI OAuth failed", {
      reason: "auth",
      provider: "openai",
      model: "gpt-5.5",
      profileId: "openai:user@example.com",
      authProfileFailure: { allInCooldown: false },
      status: 401,
      cause: refreshError,
    });
    const summaryError = new Error("All models failed", { cause: failoverError });
    summaryError.name = "FallbackSummaryError";
    Object.assign(summaryError, {
      attempts: [
        {
          provider: "openai",
          model: "gpt-5.5",
          error: "OpenAI OAuth failed",
          reason: "auth",
        },
      ],
      soonestCooldownExpiry: null,
    });
    state.runEmbeddedAgentMock.mockRejectedValueOnce(summaryError);

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const result = await runAgentTurnWithFallback(createMinimalRunAgentTurnParams());

    expect(result.kind).toBe("final");
    if (result.kind === "final") {
      expect(result.payload.text).toContain("--profile-id 'openai:user@example.com'");
    }
  });

  it("omits OAuth profile ids from group reauth guidance", async () => {
    state.runEmbeddedAgentMock.mockRejectedValueOnce(
      new OAuthRefreshFailureError({
        provider: "openai",
        profileId: "openai:user@example.com",
        message: "invalid_grant",
      }),
    );

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const result = await runAgentTurnWithFallback(
      createMinimalRunAgentTurnParams({
        sessionCtx: {
          Provider: "whatsapp",
          MessageSid: "msg",
          ChatType: "group",
        } as unknown as TemplateContext,
      }),
    );

    expect(result.kind).toBe("final");
    if (result.kind === "final") {
      expect(result.payload.text).toContain(
        "openclaw models auth login --provider openai` in a terminal",
      );
      expect(result.payload.text).not.toContain("user@example.com");
    }
  });

  it("keeps non-OpenAI OAuth refresh failures on provider-specific terminal guidance", async () => {
    state.runEmbeddedAgentMock.mockRejectedValueOnce(
      new OAuthRefreshFailureError({
        provider: "anthropic",
        message: "invalid_grant",
      }),
    );

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const result = await runAgentTurnWithFallback(createMinimalRunAgentTurnParams());

    expect(result.kind).toBe("final");
    if (result.kind === "final") {
      expect(result.payload.text).toBe(
        "⚠️ Model login expired on the gateway for anthropic. Re-auth with `openclaw models auth login --provider anthropic` in a terminal, then try again.",
      );
      expect(result.payload.text).not.toContain("/login codex");
    }
  });

  it("surfaces claude-cli re-auth hint over generic provider auth copy for 401 OAuth expiry", async () => {
    // When the claude subprocess emits a 401 "Failed to authenticate" because
    // its OAuth token has expired, the error is wrapped as a FailoverError with
    // reason:"auth" and status:401.  Without the ordering fix, this would be
    // caught by classifyProviderRequestError before reaching classifyOAuthRefreshFailure,
    // producing the generic "re-authenticate this provider" copy instead of the
    // targeted claude-cli re-auth command.
    state.runEmbeddedAgentMock.mockRejectedValueOnce(
      new FailoverError(
        "Provider claude-cli failed: Failed to authenticate. API Error: 401 Invalid authentication credentials",
        {
          reason: "auth",
          provider: "claude-cli",
          model: "claude-sonnet-4-20250514",
          status: 401,
        },
      ),
    );

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const result = await runAgentTurnWithFallback(createMinimalRunAgentTurnParams());

    expect(result.kind).toBe("final");
    if (result.kind === "final") {
      expect(result.payload.text).toBe(
        "⚠️ Model login expired on the gateway for claude-cli. Re-auth with `claude auth login && openclaw models auth login --provider anthropic --method cli` in a terminal, then try again.",
      );
    }
  });

  it("surfaces claude-cli re-auth hint from structured provider metadata when the message omits claude-cli", async () => {
    state.runEmbeddedAgentMock.mockRejectedValueOnce(
      new FailoverError(
        "Failed to authenticate. API Error: 401 Invalid authentication credentials",
        {
          reason: "auth",
          provider: "claude-cli",
          model: "claude-sonnet-4-20250514",
          status: 401,
        },
      ),
    );

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const result = await runAgentTurnWithFallback(createMinimalRunAgentTurnParams());

    expect(result.kind).toBe("final");
    if (result.kind === "final") {
      expect(result.payload.text).toBe(
        "⚠️ Model login expired on the gateway for claude-cli. Re-auth with `claude auth login && openclaw models auth login --provider anthropic --method cli` in a terminal, then try again.",
      );
    }
  });

  it("surfaces direct provider auth guidance for missing API keys", async () => {
    state.runEmbeddedAgentMock.mockRejectedValueOnce(
      new Error(
        'No API key found for provider "openai". You are authenticated with OpenAI Codex OAuth; OpenAI agent model runs use openai/gpt-* through the Codex runtime. Set OPENAI_API_KEY only for direct OpenAI API-key surfaces. | No API key found for provider "openai". You are authenticated with OpenAI Codex OAuth; OpenAI agent model runs use openai/gpt-* through the Codex runtime. Set OPENAI_API_KEY only for direct OpenAI API-key surfaces.',
      ),
    );

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const result = await runAgentTurnWithFallback({
      commandBody: "hello",
      followupRun: createFollowupRun(),
      sessionCtx: {
        Provider: "whatsapp",
        MessageSid: "msg",
      } as unknown as TemplateContext,
      opts: {},
      typingSignals: createMockTypingSignaler(),
      blockReplyPipeline: null,
      blockStreamingEnabled: false,
      resolvedBlockStreamingBreak: "message_end",
      applyReplyToMode: (payload) => payload,
      shouldEmitToolResult: () => true,
      shouldEmitToolOutput: () => false,
      pendingToolTasks: new Set(),
      resetSessionAfterRoleOrderingConflict: async () => false,
      isHeartbeat: false,
      sessionKey: "main",
      getActiveSessionEntry: () => undefined,
      resolvedVerboseLevel: "off",
    });

    expect(result.kind).toBe("final");
    if (result.kind === "final") {
      expect(result.payload.text).toBe(
        "⚠️ Missing API key for OpenAI on the gateway. Use `openai/gpt-5.6-sol` with the OpenAI OAuth profile, or set `OPENAI_API_KEY` for direct OpenAI API-key runs.",
      );
    }
  });

  it("surfaces typed missing API-key auth guidance without parsing the message", async () => {
    state.runEmbeddedAgentMock.mockRejectedValueOnce(
      new MissingProviderAuthError("openai", {
        mode: "api-key",
        source: "env: OPENAI_API_KEY",
      }),
    );

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const result = await runAgentTurnWithFallback(createMinimalRunAgentTurnParams());

    expect(result.kind).toBe("final");
    if (result.kind === "final") {
      expect(result.payload.text).toBe(
        '⚠️ Missing API key for provider "openai". Run `openclaw doctor --fix` to repair stale OpenAI model/session routes, restart the gateway if doctor asks, then try again. If doctor has nothing to repair or the error persists, re-auth with `openclaw models auth login --provider openai` or run `openclaw configure`.',
      );
    }
  });

  it("formats auth-profile failover copy from typed FailoverError metadata", async () => {
    state.runEmbeddedAgentMock.mockRejectedValueOnce(
      new FailoverError("Auth profile failover exhausted for provider openai", {
        reason: "auth",
        provider: "openai",
        status: 401,
        authProfileFailure: { allInCooldown: true },
        cause: new Error("invalid_grant"),
      }),
    );

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const result = await runAgentTurnWithFallback(createMinimalRunAgentTurnParams());

    expect(result.kind).toBe("final");
    if (result.kind === "final") {
      expect(result.payload.text).toContain("Couldn't sign in to openai.");
      expect(result.payload.text).toContain("openclaw configure");
      expect(result.payload.text).toContain("(invalid_grant)");
      expect(result.payload.text).not.toContain("Auth profile failover exhausted");
    }
  });

  it("does not suggest re-authentication for typed format failures", async () => {
    state.runEmbeddedAgentMock.mockRejectedValueOnce(
      new FailoverError("Format failover exhausted for provider openai", {
        reason: "format",
        provider: "openai",
        authProfileFailure: { allInCooldown: true },
        cause: new Error("messages must alternate roles"),
      }),
    );

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const result = await runAgentTurnWithFallback(createMinimalRunAgentTurnParams());

    expect(result.kind).toBe("final");
    if (result.kind === "final") {
      expect(result.payload.text).toContain("Couldn't reach openai");
      expect(result.payload.text).toContain("messages must alternate roles");
      expect(result.payload.text).not.toContain("models auth login");
      expect(result.payload.text).not.toContain("openclaw configure");
    }
  });

  it("points stale openai missing-key failures at doctor repair with re-auth fallback", async () => {
    state.runEmbeddedAgentMock.mockRejectedValueOnce(
      new Error('No API key found for provider "openai".'),
    );

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const result = await runAgentTurnWithFallback(createMinimalRunAgentTurnParams());

    expect(result.kind).toBe("final");
    if (result.kind === "final") {
      expect(result.payload.text).toBe(
        '⚠️ Missing API key for provider "openai". Run `openclaw doctor --fix` to repair stale OpenAI model/session routes, restart the gateway if doctor asks, then try again. If doctor has nothing to repair or the error persists, re-auth with `openclaw models auth login --provider openai` or run `openclaw configure`.',
      );
    }
  });

  it("falls back to a generic provider message for unsafe missing-key provider ids", async () => {
    state.runEmbeddedAgentMock.mockRejectedValueOnce(
      new Error('No API key found for provider "openai`\nrm -rf /".'),
    );

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const result = await runAgentTurnWithFallback({
      commandBody: "hello",
      followupRun: createFollowupRun(),
      sessionCtx: {
        Provider: "whatsapp",
        MessageSid: "msg",
      } as unknown as TemplateContext,
      opts: {},
      typingSignals: createMockTypingSignaler(),
      blockReplyPipeline: null,
      blockStreamingEnabled: false,
      resolvedBlockStreamingBreak: "message_end",
      applyReplyToMode: (payload) => payload,
      shouldEmitToolResult: () => true,
      shouldEmitToolOutput: () => false,
      pendingToolTasks: new Set(),
      resetSessionAfterRoleOrderingConflict: async () => false,
      isHeartbeat: false,
      sessionKey: "main",
      getActiveSessionEntry: () => undefined,
      resolvedVerboseLevel: "off",
    });

    expect(result.kind).toBe("final");
    if (result.kind === "final") {
      expect(result.payload.text).toBe(
        "⚠️ Missing API key for the selected provider on the gateway. Configure provider auth, then try again.",
      );
    }
  });

  it("falls back to a generic reauth command when the provider in the OAuth error is unsafe", async () => {
    state.runEmbeddedAgentMock.mockRejectedValueOnce(
      new Error(
        "OAuth token refresh failed for openai`\nrm -rf /: invalid_grant. Please try again or re-authenticate.",
      ),
    );

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const result = await runAgentTurnWithFallback({
      commandBody: "hello",
      followupRun: createFollowupRun(),
      sessionCtx: {
        Provider: "whatsapp",
        MessageSid: "msg",
      } as unknown as TemplateContext,
      opts: {},
      typingSignals: createMockTypingSignaler(),
      blockReplyPipeline: null,
      blockStreamingEnabled: false,
      resolvedBlockStreamingBreak: "message_end",
      applyReplyToMode: (payload) => payload,
      shouldEmitToolResult: () => true,
      shouldEmitToolOutput: () => false,
      pendingToolTasks: new Set(),
      resetSessionAfterRoleOrderingConflict: async () => false,
      isHeartbeat: false,
      sessionKey: "main",
      getActiveSessionEntry: () => undefined,
      resolvedVerboseLevel: "off",
    });

    expect(result.kind).toBe("final");
    if (result.kind === "final") {
      expect(result.payload.text).toBe(
        "⚠️ Model login expired on the gateway. Re-auth with `openclaw models auth login` in a terminal, then try again.",
      );
    }
  });
});
