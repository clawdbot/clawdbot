import { describe, expect, it } from "vitest";
import { formatBillingErrorMessage } from "../../agents/embedded-agent-helpers.js";
import { FailoverError } from "../../agents/failover-error.js";
import type { TemplateContext } from "../templating.js";
import { SILENT_REPLY_TOKEN } from "../tokens.js";
import {
  PROVIDER_AUTHENTICATION_ERROR_USER_MESSAGE,
  PROVIDER_RATE_LIMIT_OR_QUOTA_ERROR_USER_MESSAGE,
  PROVIDER_INTERNAL_ERROR_USER_MESSAGE,
  setupAgentRunnerExecutionTestState,
  GENERIC_RUN_FAILURE_TEXT,
  getRunAgentTurnWithFallback,
  createMockTypingSignaler,
  createFollowupRun,
  createMinimalRunAgentTurnParams,
  NON_DIRECT_FAILURE_SURFACE_CASES,
  createNonDirectFailureSessionCtx,
} from "./agent-runner-execution.test-support.js";
import { buildKnownAgentRunFailureReplyPayload } from "./agent-runner-failure-reply.js";

const state = setupAgentRunnerExecutionTestState();

describe("runAgentTurnWithFallback: provider failures", () => {
  it.each(NON_DIRECT_FAILURE_SURFACE_CASES)(
    "keeps raw runner failure boilerplate out of $label chats",
    async (testCase) => {
      state.runEmbeddedAgentMock.mockRejectedValueOnce(
        new Error("openai/gpt-5.5 ended with an incomplete terminal response"),
      );

      const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
      const result = await runAgentTurnWithFallback(
        createMinimalRunAgentTurnParams({
          sessionCtx: createNonDirectFailureSessionCtx(testCase),
        }),
      );

      expect(result.kind).toBe("final");
      if (result.kind === "final") {
        expect(result.payload.text).toBe(SILENT_REPLY_TOKEN);
      }
    },
  );

  it.each(["group", "channel"] as const)(
    "surfaces raw runner failure copy in Discord %s chats when silentReply.group is set to disallow",
    async (chatType) => {
      state.runEmbeddedAgentMock.mockRejectedValueOnce(
        new Error("openai/gpt-5.5 ended with an incomplete terminal response"),
      );

      const followupRun = createFollowupRun();
      followupRun.run.config = {
        agents: {
          defaults: {
            silentReply: { group: "disallow" },
          },
        },
      };

      const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
      const result = await runAgentTurnWithFallback(
        createMinimalRunAgentTurnParams({
          followupRun,
          sessionCtx: {
            Provider: "discord",
            Surface: "discord",
            ChatType: chatType,
            GroupSubject: "agent group",
            GroupChannel: "#general",
            MessageSid: "msg",
          } as unknown as TemplateContext,
        }),
      );

      expect(result.kind).toBe("final");
      if (result.kind === "final") {
        expect(result.payload.text).not.toBe(SILENT_REPLY_TOKEN);
        expect(result.payload.text).toBe(GENERIC_RUN_FAILURE_TEXT);
      }
    },
  );

  it("surfaces raw runner failure copy when per-surface silentReply.group is set to disallow", async () => {
    state.runEmbeddedAgentMock.mockRejectedValueOnce(
      new Error("openai/gpt-5.5 ended with an incomplete terminal response"),
    );

    const followupRun = createFollowupRun();
    followupRun.run.config = {
      agents: {
        defaults: {
          silentReply: { group: "allow" },
        },
      },
      surfaces: {
        discord: {
          silentReply: { group: "disallow" },
        },
      },
    };

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const result = await runAgentTurnWithFallback(
      createMinimalRunAgentTurnParams({
        followupRun,
        sessionCtx: {
          Provider: "discord",
          Surface: "discord",
          ChatType: "group",
          GroupSubject: "agent group",
          GroupChannel: "#general",
          MessageSid: "msg",
        } as unknown as TemplateContext,
      }),
    );

    expect(result.kind).toBe("final");
    if (result.kind === "final") {
      expect(result.payload.text).toBe(GENERIC_RUN_FAILURE_TEXT);
    }
  });

  it.each(NON_DIRECT_FAILURE_SURFACE_CASES)(
    "keeps default silent behavior in $label chats when silentReply policy is unset",
    async (testCase) => {
      state.runEmbeddedAgentMock.mockRejectedValueOnce(
        new Error("openai/gpt-5.5 ended with an incomplete terminal response"),
      );

      const followupRun = createFollowupRun();
      followupRun.run.config = {};

      const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
      const result = await runAgentTurnWithFallback(
        createMinimalRunAgentTurnParams({
          followupRun,
          sessionCtx: createNonDirectFailureSessionCtx(testCase),
        }),
      );

      expect(result.kind).toBe("final");
      if (result.kind === "final") {
        expect(result.payload.text).toBe(SILENT_REPLY_TOKEN);
      }
    },
  );

  it.each(NON_DIRECT_FAILURE_SURFACE_CASES)(
    "keeps classified non-transient failures visible in $label chats",
    async (testCase) => {
      state.runEmbeddedAgentMock.mockRejectedValueOnce(
        new Error('No API key found for provider "openai"'),
      );

      const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
      const result = await runAgentTurnWithFallback(
        createMinimalRunAgentTurnParams({
          sessionCtx: createNonDirectFailureSessionCtx(testCase),
        }),
      );

      expect(result.kind).toBe("final");
      if (result.kind === "final") {
        expect(result.payload.text).not.toBe(SILENT_REPLY_TOKEN);
        expect(result.payload.text).toContain('Missing API key for provider "openai"');
      }
    },
  );

  it.each(NON_DIRECT_FAILURE_SURFACE_CASES)(
    "surfaces provider authentication failures in $label chats",
    async (testCase) => {
      const rawError =
        "unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, url: https://api.openai.com/v1/responses";
      state.runEmbeddedAgentMock.mockRejectedValueOnce(
        new FailoverError("LLM request unauthorized.", {
          reason: "auth",
          provider: "openai",
          model: "gpt-5.5",
          status: 401,
          rawError,
        }),
      );

      const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
      const result = await runAgentTurnWithFallback(
        createMinimalRunAgentTurnParams({
          sessionCtx: createNonDirectFailureSessionCtx(testCase),
        }),
      );

      expect(result.kind).toBe("final");
      if (result.kind === "final") {
        expect(result.payload.isError).toBe(true);
        expect(result.payload.text).toBe(PROVIDER_AUTHENTICATION_ERROR_USER_MESSAGE);
        expect(result.payload.text).not.toBe(SILENT_REPLY_TOKEN);
        expect(result.payload.text).not.toContain(rawError);
      }
    },
  );

  it.each(NON_DIRECT_FAILURE_SURFACE_CASES)(
    "surfaces rate-limit fallback copy in $label chats",
    async (testCase) => {
      state.runEmbeddedAgentMock.mockRejectedValueOnce(new Error("429 rate limit exceeded"));

      const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
      const result = await runAgentTurnWithFallback(
        createMinimalRunAgentTurnParams({
          sessionCtx: createNonDirectFailureSessionCtx(testCase),
        }),
      );

      expect(result.kind).toBe("final");
      if (result.kind === "final") {
        expect(result.payload.isError).toBe(true);
        expect(result.payload.text).not.toBe(SILENT_REPLY_TOKEN);
        expect(result.payload.text).toContain("rate-limited");
      }
    },
  );

  it.each(NON_DIRECT_FAILURE_SURFACE_CASES)(
    "surfaces typed periodic rate-limit details in $label chats",
    async (testCase) => {
      const periodicLimitMessage = "You've hit your weekly limit · resets 6pm (UTC)";
      state.runEmbeddedAgentMock.mockRejectedValueOnce(
        new FailoverError(periodicLimitMessage, {
          reason: "rate_limit",
          provider: "anthropic",
          model: "claude-opus-4-1",
          rawError: periodicLimitMessage,
        }),
      );

      const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
      const result = await runAgentTurnWithFallback(
        createMinimalRunAgentTurnParams({
          sessionCtx: createNonDirectFailureSessionCtx(testCase),
        }),
      );

      expect(result.kind).toBe("final");
      if (result.kind === "final") {
        expect(result.payload.isError).toBe(true);
        expect(result.payload.text).not.toBe(SILENT_REPLY_TOKEN);
        expect(result.payload.text).toContain("weekly limit");
        expect(result.payload.text).toContain("resets 6pm");
        expect(result.payload.text).not.toContain("few minutes");
      }
    },
  );

  it("surfaces typed periodic rate-limit details through known failure payloads in group chats", () => {
    const periodicLimitMessage = "You've hit your weekly limit · resets 6pm (UTC)";
    const payload = buildKnownAgentRunFailureReplyPayload({
      err: new FailoverError(periodicLimitMessage, {
        reason: "rate_limit",
        provider: "anthropic",
        model: "claude-opus-4-1",
        rawError: periodicLimitMessage,
      }),
      sessionCtx: createNonDirectFailureSessionCtx(NON_DIRECT_FAILURE_SURFACE_CASES[0]),
      resolvedVerboseLevel: "off",
    });

    expect(payload).toBeDefined();
    expect(payload?.isError).toBe(true);
    expect(payload?.text).not.toBe(SILENT_REPLY_TOKEN);
    expect(payload?.text).toContain("weekly limit");
    expect(payload?.text).toContain("resets 6pm");
    expect(payload?.text).not.toContain("few minutes");
  });

  it.each(NON_DIRECT_FAILURE_SURFACE_CASES)(
    "surfaces overloaded fallback copy in $label chats",
    async (testCase) => {
      state.runEmbeddedAgentMock.mockRejectedValueOnce(new Error("model is overloaded"));

      const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
      const result = await runAgentTurnWithFallback(
        createMinimalRunAgentTurnParams({
          sessionCtx: createNonDirectFailureSessionCtx(testCase),
        }),
      );

      expect(result.kind).toBe("final");
      if (result.kind === "final") {
        expect(result.payload.isError).toBe(true);
        expect(result.payload.text).not.toBe(SILENT_REPLY_TOKEN);
        expect(result.payload.text).toContain("overloaded");
      }
    },
  );

  it("surfaces typed overloaded failures without rate-limit cooldown copy", async () => {
    state.runEmbeddedAgentMock.mockRejectedValueOnce(
      new FailoverError("529 Please try again", {
        reason: "overloaded",
        provider: "anthropic",
        model: "claude-opus-4-1",
        status: 529,
      }),
    );

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const result = await runAgentTurnWithFallback(
      createMinimalRunAgentTurnParams({
        sessionCtx: createNonDirectFailureSessionCtx(NON_DIRECT_FAILURE_SURFACE_CASES[0]),
      }),
    );

    expect(result.kind).toBe("final");
    if (result.kind === "final") {
      expect(result.payload.isError).toBe(true);
      expect(result.payload.text).not.toBe(SILENT_REPLY_TOKEN);
      expect(result.payload.text).toContain("overloaded");
      expect(result.payload.text).not.toContain("rate-limited");
      expect(result.payload.text).not.toContain("few minutes");
    }
  });

  it("surfaces rate-limit fallback copy in Discord group chats when silentReply.group is disallow", async () => {
    state.runEmbeddedAgentMock.mockRejectedValueOnce(new Error("429 rate limit exceeded"));

    const followupRun = createFollowupRun();
    followupRun.run.config = {
      agents: {
        defaults: {
          silentReply: { group: "disallow" },
        },
      },
    };

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const result = await runAgentTurnWithFallback(
      createMinimalRunAgentTurnParams({
        followupRun,
        sessionCtx: {
          Provider: "discord",
          Surface: "discord",
          ChatType: "group",
          GroupSubject: "agent group",
          GroupChannel: "#general",
          MessageSid: "msg",
        } as unknown as TemplateContext,
      }),
    );

    expect(result.kind).toBe("final");
    if (result.kind === "final") {
      expect(result.payload.isError).toBe(true);
      expect(result.payload.text).not.toBe(SILENT_REPLY_TOKEN);
      expect(result.payload.text).toContain("rate-limited");
    }
  });

  it("uses compact generic copy for raw runner failures in normal Discord direct chats", async () => {
    state.runEmbeddedAgentMock.mockRejectedValueOnce(
      new Error("openai/gpt-5.5 ended with an incomplete terminal response"),
    );

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const result = await runAgentTurnWithFallback(
      createMinimalRunAgentTurnParams({
        sessionCtx: {
          Provider: "discord",
          Surface: "discord",
          ChatType: "direct",
          MessageSid: "msg",
        } as unknown as TemplateContext,
      }),
    );

    expect(result.kind).toBe("final");
    if (result.kind === "final") {
      expect(result.payload.text).toBe(GENERIC_RUN_FAILURE_TEXT);
    }
  });

  it("keeps raw runner failure guidance visible in verbose Discord direct chats", async () => {
    state.runEmbeddedAgentMock.mockRejectedValueOnce(
      new Error("openai/gpt-5.5 ended with an incomplete terminal response"),
    );

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const result = await runAgentTurnWithFallback({
      ...createMinimalRunAgentTurnParams({
        sessionCtx: {
          Provider: "discord",
          Surface: "discord",
          ChatType: "direct",
          MessageSid: "msg",
        } as unknown as TemplateContext,
      }),
      resolvedVerboseLevel: "on",
    });

    expect(result.kind).toBe("final");
    if (result.kind === "final") {
      expect(result.payload.text).toContain("Agent failed before reply");
      expect(result.payload.text).toContain("incomplete terminal response");
    }
  });

  it("surfaces provider quota guidance for generic HTTP 429 failures before reply", async () => {
    const error = new Error(
      "Something went wrong while processing your request. Please try again.",
    );
    Object.assign(error, { status: 429 });
    state.runEmbeddedAgentMock.mockRejectedValueOnce(error);

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const result = await runAgentTurnWithFallback(
      createMinimalRunAgentTurnParams({
        sessionCtx: {
          Provider: "discord",
          Surface: "discord",
          ChatType: "direct",
          MessageSid: "msg",
        } as unknown as TemplateContext,
      }),
    );

    expect(result.kind).toBe("final");
    if (result.kind === "final") {
      expect(result.payload.text).toBe(PROVIDER_RATE_LIMIT_OR_QUOTA_ERROR_USER_MESSAGE);
      expect(result.payload.text).not.toBe(GENERIC_RUN_FAILURE_TEXT);
    }
  });

  it("surfaces provider internal errors without session reset guidance before reply", async () => {
    state.runEmbeddedAgentMock.mockRejectedValueOnce(
      new FailoverError(
        "The AI service returned an internal error. Please try again in a moment.",
        {
          reason: "server_error",
          provider: "fyapis",
          model: "gpt-5.5",
          status: 500,
        },
      ),
    );

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const result = await runAgentTurnWithFallback(
      createMinimalRunAgentTurnParams({
        sessionCtx: {
          Provider: "telegram",
          Surface: "telegram",
          ChatType: "direct",
          MessageSid: "msg",
        } as unknown as TemplateContext,
      }),
    );

    expect(result.kind).toBe("final");
    if (result.kind === "final") {
      expect(result.payload.text).toBe(PROVIDER_INTERNAL_ERROR_USER_MESSAGE);
      expect(result.payload.text).not.toContain("/new");
      expect(result.payload.text).not.toBe(GENERIC_RUN_FAILURE_TEXT);
    }
  });

  it("surfaces billing guidance for Volcengine Coding Plan subscription failures before reply", async () => {
    state.runEmbeddedAgentMock.mockRejectedValueOnce(
      new Error(
        'HTTP 400 Bad Request: {"error":{"code":"InvalidSubscription","message":"Your account does not have a valid CodingPlan subscription, or your subscription has expired."}}',
      ),
    );

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const result = await runAgentTurnWithFallback(
      createMinimalRunAgentTurnParams({
        sessionCtx: {
          Provider: "discord",
          Surface: "discord",
          ChatType: "direct",
          MessageSid: "msg",
        } as unknown as TemplateContext,
      }),
    );

    expect(result.kind).toBe("final");
    if (result.kind === "final") {
      expect(result.payload.text).toBe("billing");
      expect(result.payload.text).not.toBe(GENERIC_RUN_FAILURE_TEXT);
    }
  });

  it("preserves neutral billing guidance for OAuth failover errors", async () => {
    state.runEmbeddedAgentMock.mockRejectedValueOnce(
      new FailoverError(formatBillingErrorMessage("Anthropic", "claude-sonnet-4-5", "oauth"), {
        reason: "billing",
        provider: "Anthropic",
        model: "claude-sonnet-4-5",
        authMode: "oauth",
      }),
    );

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const result = await runAgentTurnWithFallback(createMinimalRunAgentTurnParams());

    expect(result.kind).toBe("final");
    if (result.kind === "final") {
      expect(result.payload.text).toContain("check your account for subscription or usage limits");
      expect(result.payload.text).not.toContain("API key");
      expect(result.payload.text).not.toContain("top up");
    }
  });

  it("preserves neutral billing guidance after fallback exhaustion", async () => {
    state.runWithModelFallbackMock.mockRejectedValueOnce(
      Object.assign(new Error("All models failed (1): openai/gpt-5.5: billing"), {
        name: "FallbackSummaryError",
        attempts: [
          {
            provider: "openai",
            model: "gpt-5.5",
            error: "billing",
            reason: "billing",
            authMode: "oauth",
          },
        ],
        soonestCooldownExpiry: null,
      }),
    );

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const result = await runAgentTurnWithFallback(createMinimalRunAgentTurnParams());

    expect(result.kind).toBe("final");
    if (result.kind === "final") {
      expect(result.payload.text).toContain("check your account for subscription or usage limits");
      expect(result.payload.text).not.toContain("API key");
      expect(result.payload.text).not.toContain("top up");
    }
  });

  it("formats raw Codex API payloads before forwarding verbose external errors", async () => {
    state.runEmbeddedAgentMock.mockRejectedValueOnce(
      new Error(
        'Codex error: {"type":"error","error":{"type":"server_error","message":"Something exploded"},"sequence_number":2}',
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
      resolvedVerboseLevel: "on",
    });

    expect(result.kind).toBe("final");
    if (result.kind === "final") {
      expect(result.payload.text).toBe(
        "⚠️ Agent failed before reply: LLM error server_error: Something exploded. Please try again, or use /new to start a fresh session.",
      );
    }
  });
});
