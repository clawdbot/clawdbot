import { describe, expect, it } from "vitest";
import { OAuthRefreshFailureError } from "../../agents/auth-profiles/oauth-refresh-failure.js";
import { createCliOutputFailoverError } from "../../agents/cli-runner/output-error.js";
import { FailoverError } from "../../agents/failover-error.js";
import { MissingProviderAuthError, ProviderAuthError } from "../../agents/model-auth.js";
import { buildProviderLoginRecovery } from "../provider-login-recovery.js";
import type { TemplateContext } from "../templating.js";
import {
  setupAgentRunnerExecutionTestState,
  getExecuteAgentTurnForTest,
  createMockTypingSignaler,
  createFollowupRun,
  createMinimalRunAgentTurnParams,
  createTestFallbackSummaryError,
} from "./agent-runner-execution.test-support.js";
import { buildKnownAgentRunFailureReplyPayload } from "./agent-runner-failure-reply.js";

const state = setupAgentRunnerExecutionTestState();

const CODEX_LOGIN_PRESENTATION = {
  blocks: [
    {
      type: "buttons",
      buttons: [
        {
          label: "Sign in to OpenAI",
          action: { type: "command", command: "/login codex" },
        },
      ],
    },
  ],
};

describe("executeAgentTurn: authentication failures", () => {
  it("does not guess a login provider from unattributed OAuth failure evidence", () => {
    expect(
      buildProviderLoginRecovery({ provider: null, oauthReason: "invalid_grant" }),
    ).toBeUndefined();
  });

  it("surfaces gateway reauth guidance without a profile id", async () => {
    state.runEmbeddedAgentMock.mockRejectedValueOnce(
      new OAuthRefreshFailureError({ provider: "openai", message: "refresh_token_reused" }),
    );

    const executeAgentTurn = await getExecuteAgentTurnForTest();
    const result = await executeAgentTurn({
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
        "⚠️ OpenAI needs a new login. Send `/login codex` from a private chat or Control UI session. Where shown, you can also select **Sign in to OpenAI**. You can also re-auth with `openclaw models auth login --provider openai` on the gateway.",
      );
      expect(result.payload.presentation).toEqual(CODEX_LOGIN_PRESENTATION);
    }
  });

  it("adds Codex login recovery to raw forwarded refresh failures", async () => {
    const message = "OAuth token refresh failed for openai: refresh_token_invalidated";
    state.runEmbeddedAgentMock.mockRejectedValueOnce(
      new FailoverError(message, {
        reason: "auth_permanent",
        provider: "openai",
        model: "gpt-5.6-sol",
        status: 401,
        rawError: message,
      }),
    );

    const executeAgentTurn = await getExecuteAgentTurnForTest();
    const result = await executeAgentTurn(createMinimalRunAgentTurnParams());

    expect(result.kind).toBe("final");
    if (result.kind === "final") {
      expect(result.payload.presentation).toEqual(CODEX_LOGIN_PRESENTATION);
    }
  });

  it("keeps Codex login recovery actionable on Control UI turns", async () => {
    state.isInternalMessageChannelMock.mockReturnValue(true);
    state.runEmbeddedAgentMock.mockRejectedValueOnce(
      new OAuthRefreshFailureError({ provider: "openai", message: "refresh_token_reused" }),
    );
    const followupRun = createFollowupRun();
    followupRun.run.messageProvider = "webchat";

    const executeAgentTurn = await getExecuteAgentTurnForTest();
    const result = await executeAgentTurn(
      createMinimalRunAgentTurnParams({
        followupRun,
        sessionCtx: { Provider: "webchat", MessageSid: "msg" } as unknown as TemplateContext,
      }),
    );

    expect(result.kind).toBe("final");
    if (result.kind === "final") {
      expect(result.payload.text).toBe(
        "⚠️ OpenAI needs a new login. Send `/login codex` from a private chat or Control UI session. Where shown, you can also select **Sign in to OpenAI**. You can also re-auth with `openclaw models auth login --provider openai` on the gateway.",
      );
      expect(result.payload.presentation).toEqual(CODEX_LOGIN_PRESENTATION);
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

    const executeAgentTurn = await getExecuteAgentTurnForTest();
    const result = await executeAgentTurn(createMinimalRunAgentTurnParams());

    expect(result.kind).toBe("final");
    if (result.kind === "final") {
      expect(result.payload.text).toBe(
        "⚠️ OpenAI needs a new login. Send `/login codex` from a private chat or Control UI session. Where shown, you can also select **Sign in to OpenAI**. You can also re-auth with `openclaw models auth login --provider openai --profile-id 'openai:user@example.com'` on the gateway.",
      );
      expect(result.payload.presentation).toEqual(CODEX_LOGIN_PRESENTATION);
    }
  });

  it("preserves Codex login recovery in known failure payloads", () => {
    const payload = buildKnownAgentRunFailureReplyPayload({
      err: new OAuthRefreshFailureError({
        provider: "openai",
        message: "refresh_token_invalidated",
      }),
      sessionCtx: { Provider: "telegram", ChatType: "direct" } as TemplateContext,
      resolvedVerboseLevel: "off",
    });

    expect(payload?.presentation).toEqual(CODEX_LOGIN_PRESENTATION);
  });

  it("offers the provider-owned xAI login command for OAuth failures", () => {
    const payload = buildKnownAgentRunFailureReplyPayload({
      err: new OAuthRefreshFailureError({
        provider: "xai",
        message: "invalid_grant",
      }),
      sessionCtx: { Provider: "telegram", ChatType: "direct" } as TemplateContext,
      resolvedVerboseLevel: "off",
    });

    expect(payload?.presentation).toEqual({
      blocks: [
        {
          type: "buttons",
          buttons: [
            {
              label: "Sign in to xAI (Grok)",
              action: { type: "command", command: "/login xai" },
            },
          ],
        },
      ],
    });
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

    const executeAgentTurn = await getExecuteAgentTurnForTest();
    const result = await executeAgentTurn(createMinimalRunAgentTurnParams());

    expect(result.kind).toBe("final");
    if (result.kind === "final") {
      expect(result.payload.text).toContain("--profile-id 'openai:user@example.com'");
      expect(result.payload.presentation).toEqual(CODEX_LOGIN_PRESENTATION);
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
    const summaryError = createTestFallbackSummaryError({
      message: "All models failed",
      attempts: [
        {
          provider: "openai",
          model: "gpt-5.5",
          error: "OpenAI OAuth failed",
          reason: "auth",
        },
      ],
      soonestCooldownExpiry: null,
      cause: failoverError,
    });
    state.runEmbeddedAgentMock.mockRejectedValueOnce(summaryError);

    const executeAgentTurn = await getExecuteAgentTurnForTest();
    const result = await executeAgentTurn(createMinimalRunAgentTurnParams());

    expect(result.kind).toBe("final");
    if (result.kind === "final") {
      expect(result.payload.text).toContain("--profile-id 'openai:user@example.com'");
      expect(result.payload.presentation).toEqual(CODEX_LOGIN_PRESENTATION);
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

    const executeAgentTurn = await getExecuteAgentTurnForTest();
    const result = await executeAgentTurn(
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
      expect(result.payload.text).toContain("openclaw models auth login --provider openai");
      expect(result.payload.text).not.toContain("user@example.com");
      expect(result.payload.presentation).toEqual(CODEX_LOGIN_PRESENTATION);
    }
  });

  it("keeps disabled OpenAI OAuth profiles actionable on later turns", async () => {
    state.runEmbeddedAgentMock.mockRejectedValueOnce(
      new FailoverError("All OpenAI auth profiles are unavailable", {
        reason: "auth_permanent",
        provider: "openai",
        model: "gpt-5.6-sol",
        authMode: "oauth",
        authProfileFailure: { allInCooldown: true },
      }),
    );

    const executeAgentTurn = await getExecuteAgentTurnForTest();
    const result = await executeAgentTurn(createMinimalRunAgentTurnParams());

    expect(result.kind).toBe("final");
    if (result.kind === "final") {
      expect(result.payload.text).toContain("/login codex");
      expect(result.payload.presentation).toEqual(CODEX_LOGIN_PRESENTATION);
    }
  });

  it.each([
    {
      label: "OpenAI API-key failures",
      error: new FailoverError("invalid API key", {
        reason: "auth_permanent",
        provider: "openai",
        model: "gpt-5.5",
        authMode: "api-key",
        authProfileFailure: { allInCooldown: true },
      }),
    },
    {
      label: "transient OpenAI refresh failures",
      error: new OAuthRefreshFailureError({
        provider: "openai",
        message: "temporary upstream issue",
      }),
    },
  ])("does not offer Codex login for $label", async ({ error }) => {
    state.runEmbeddedAgentMock.mockRejectedValueOnce(error);

    const executeAgentTurn = await getExecuteAgentTurnForTest();
    const result = await executeAgentTurn(createMinimalRunAgentTurnParams());

    expect(result.kind).toBe("final");
    if (result.kind === "final") {
      expect(result.payload.presentation).toBeUndefined();
    }
  });

  it("keeps non-OpenAI OAuth refresh failures on provider-specific terminal guidance", async () => {
    state.runEmbeddedAgentMock.mockRejectedValueOnce(
      new OAuthRefreshFailureError({
        provider: "anthropic",
        message: "invalid_grant",
      }),
    );

    const executeAgentTurn = await getExecuteAgentTurnForTest();
    const result = await executeAgentTurn(createMinimalRunAgentTurnParams());

    expect(result.kind).toBe("final");
    if (result.kind === "final") {
      expect(result.payload.text).toBe(
        "⚠️ Model login expired on the gateway for anthropic. Re-auth with `openclaw models auth login --provider anthropic` in a terminal, then try again.",
      );
      expect(result.payload.text).not.toContain("/login codex");
    }
  });

  it("surfaces Agent SDK OAuth session expiry in Discord channels", async () => {
    const error = createCliOutputFailoverError({
      output: {
        text: "",
        errorText: "Failed to authenticate: OAuth session expired and could not be refreshed",
      },
      provider: "claude-cli",
      model: "claude-opus-5",
    });
    if (!error) {
      throw new Error("expected CLI output failure");
    }
    state.runEmbeddedAgentMock.mockRejectedValueOnce(error);

    const executeAgentTurn = await getExecuteAgentTurnForTest();
    const result = await executeAgentTurn(
      createMinimalRunAgentTurnParams({
        sessionCtx: {
          Provider: "discord",
          Surface: "discord",
          ChatType: "channel",
          MessageSid: "msg",
        } as unknown as TemplateContext,
      }),
    );

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

    const executeAgentTurn = await getExecuteAgentTurnForTest();
    const result = await executeAgentTurn(createMinimalRunAgentTurnParams());

    expect(result.kind).toBe("final");
    if (result.kind === "final") {
      expect(result.payload.text).toBe(
        "⚠️ Model login expired on the gateway for claude-cli. Re-auth with `claude auth login && openclaw models auth login --provider anthropic --method cli` in a terminal, then try again.",
      );
    }
  });

  it("surfaces the claude-cli re-auth hint when the CLI session is logged out", async () => {
    state.runEmbeddedAgentMock.mockRejectedValueOnce(
      new FailoverError("Not logged in · Please run /login", {
        reason: "auth",
        provider: "claude-cli",
        model: "claude-sonnet-4-20250514",
        status: 401,
      }),
    );

    const executeAgentTurn = await getExecuteAgentTurnForTest();
    const result = await executeAgentTurn(createMinimalRunAgentTurnParams());

    expect(result.kind).toBe("final");
    if (result.kind === "final") {
      expect(result.payload.text).toBe(
        "⚠️ Model login expired on the gateway for claude-cli. Re-auth with `claude auth login && openclaw models auth login --provider anthropic --method cli` in a terminal, then try again.",
      );
    }
  });

  it("surfaces direct provider auth guidance for missing API keys", async () => {
    state.runEmbeddedAgentMock.mockRejectedValueOnce(
      new ProviderAuthError(
        "missing-provider-auth",
        "openai",
        'No API key found for provider "openai". You are authenticated with OpenAI Codex OAuth.',
        { providerGuidance: true },
      ),
    );

    const executeAgentTurn = await getExecuteAgentTurnForTest();
    const result = await executeAgentTurn({
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

    const executeAgentTurn = await getExecuteAgentTurnForTest();
    const result = await executeAgentTurn(createMinimalRunAgentTurnParams());

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

    const executeAgentTurn = await getExecuteAgentTurnForTest();
    const result = await executeAgentTurn(createMinimalRunAgentTurnParams());

    expect(result.kind).toBe("final");
    if (result.kind === "final") {
      expect(result.payload.text).toContain("Couldn't sign in to openai.");
      expect(result.payload.text).toContain("openclaw configure");
      expect(result.payload.text).toContain("(invalid_grant)");
      expect(result.payload.text).not.toContain("Auth profile failover exhausted");
    }
  });

  it("renders bounded recovery when the selected auth profile is unavailable", async () => {
    state.isInternalMessageChannelMock.mockReturnValue(true);
    state.runEmbeddedAgentMock.mockRejectedValueOnce(
      new FailoverError('Codex app-server auth profile "openai:private" was not found', {
        reason: "auth",
        provider: "openai",
        status: 401,
        code: "selected_auth_profile_unavailable",
        authProfileFailure: { allInCooldown: false },
        cause: new Error("arbitrary plugin detail for openai:private"),
      }),
    );

    const executeAgentTurn = await getExecuteAgentTurnForTest();
    const result = await executeAgentTurn(createMinimalRunAgentTurnParams());

    expect(result.kind).toBe("final");
    if (result.kind === "final") {
      expect(result.payload.text).toBe(
        "The selected auth profile is unavailable in this agent's OpenClaw credential store. Import or migrate that credential into the agent, select another configured profile, or run `openclaw configure`, then retry.",
      );
      expect(result.payload.text).not.toContain("openai:private");
      expect(result.payload.text).not.toContain("arbitrary plugin detail");
      expect(result.payload.text).not.toContain("/login codex");
      expect(result.payload.presentation).toBeUndefined();
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

    const executeAgentTurn = await getExecuteAgentTurnForTest();
    const result = await executeAgentTurn(createMinimalRunAgentTurnParams());

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
      new ProviderAuthError(
        "missing-provider-auth",
        "openai",
        'No API key found for provider "openai".',
      ),
    );

    const executeAgentTurn = await getExecuteAgentTurnForTest();
    const result = await executeAgentTurn(createMinimalRunAgentTurnParams());

    expect(result.kind).toBe("final");
    if (result.kind === "final") {
      expect(result.payload.text).toBe(
        '⚠️ Missing API key for provider "openai". Run `openclaw doctor --fix` to repair stale OpenAI model/session routes, restart the gateway if doctor asks, then try again. If doctor has nothing to repair or the error persists, re-auth with `openclaw models auth login --provider openai` or run `openclaw configure`.',
      );
    }
  });

  it("falls back to a generic provider message for unsafe missing-key provider ids", async () => {
    state.runEmbeddedAgentMock.mockRejectedValueOnce(
      new ProviderAuthError(
        "missing-provider-auth",
        "openai`\nrm -rf /",
        'No API key found for provider "openai`\nrm -rf /".',
      ),
    );

    const executeAgentTurn = await getExecuteAgentTurnForTest();
    const result = await executeAgentTurn({
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
      new OAuthRefreshFailureError({ provider: "openai`\nrm -rf /", message: "invalid_grant" }),
    );

    const executeAgentTurn = await getExecuteAgentTurnForTest();
    const result = await executeAgentTurn({
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
