import { describe, expect, it } from "vitest";
import { FailoverError } from "../../agents/failover-error.js";
import {
  GENERIC_EXTERNAL_RUN_FAILURE_TEXT,
  HEARTBEAT_EXTERNAL_RUN_FAILURE_TEXT,
} from "../../agents/failover/user-copy.js";
import { AgentHarnessPreflightError } from "../../agents/harness/errors.js";
import { SILENT_REPLY_TOKEN } from "../tokens.js";
import {
  buildEmptyInteractiveReplyPayload,
  buildExternalRunFailureReply,
  buildKnownAgentRunFailureReplyPayload,
  buildPreflightCompactionFailureText,
  resolveExternalRunFailureTextForConversation,
} from "./agent-runner-failure-reply.js";

const EMPTY_INTERACTIVE_REPLY_TEXT =
  "I finished the turn, but it did not produce a visible reply. Please try again, or start a new session if this keeps happening.";

describe("buildEmptyInteractiveReplyPayload", () => {
  const baseParams = {
    isInteractive: true,
    hasPendingContinuation: false,
    hasExplicitSilentReply: false,
    hasCommittedDelivery: false,
    hasIntentionalTerminalCompletion: false,
    sessionCtx: {
      Provider: "discord",
      Surface: "discord",
      ChatType: "group",
    },
  } as const;

  it("preserves the default silent policy in group conversations", () => {
    const payload = buildEmptyInteractiveReplyPayload(baseParams);

    expect(payload?.text).toBe(SILENT_REPLY_TOKEN);
    expect(payload?.isError).toBeUndefined();
  });

  it("surfaces the fallback when group silence is explicitly disallowed", () => {
    expect(
      buildEmptyInteractiveReplyPayload({
        ...baseParams,
        cfg: { agents: { defaults: { silentReply: { group: "disallow" } } } },
      }),
    ).toMatchObject({ text: EMPTY_INTERACTIVE_REPLY_TEXT, isError: true });
  });
});

describe("buildExternalRunFailureReply", () => {
  it.each(["401 unauthorized", "529 overloaded", "503 service unavailable", "402 billing"])(
    "keeps preflight %s diagnostics behind verbose opt-in",
    (failure) => {
      const message = `${failure}; reconnect before continuing. diagnostic-canary ${"x".repeat(1500)}`;
      const input = {
        message,
        error: new AgentHarnessPreflightError(message, {
          cause: new FailoverError("provider diagnostic", {
            reason: failure.startsWith("401") ? "auth" : "overloaded",
            status: failure.startsWith("401") ? 401 : 529,
          }),
        }),
      };
      expect(
        buildKnownAgentRunFailureReplyPayload({
          err: input.error,
          sessionCtx: { Provider: "discord", Surface: "discord", ChatType: "group" },
          resolvedVerboseLevel: "off",
        }),
      ).toBeUndefined();
      expect(buildExternalRunFailureReply(input)).toEqual({
        text: GENERIC_EXTERNAL_RUN_FAILURE_TEXT,
        isGenericRunnerFailure: true,
      });
      const heartbeat = buildExternalRunFailureReply(input, {
        isHeartbeat: true,
        includeDetails: true,
      });
      expect(heartbeat.text).toBe(HEARTBEAT_EXTERNAL_RUN_FAILURE_TEXT);
      expect(
        resolveExternalRunFailureTextForConversation({
          text: heartbeat.text,
          isGenericRunnerFailure: heartbeat.isGenericRunnerFailure,
          sessionCtx: { Provider: "discord", Surface: "discord", ChatType: "group" },
        }),
      ).toBe(HEARTBEAT_EXTERNAL_RUN_FAILURE_TEXT);
      const verbose = buildExternalRunFailureReply(input, { includeDetails: true });
      expect(verbose.isGenericRunnerFailure).toBe(true);
      expect(verbose.text).toContain("reconnect before continuing");
      expect(verbose.text).toContain("diagnostic-canary");
      expect(verbose.text).toBe(
        `⚠️ Agent failed before reply: ${message.slice(0, 899)}…. Please try again, or use /new to start a fresh session.`,
      );
    },
  );

  it("forwards classified provider copy when verbose detail is off", () => {
    const message = "opaque provider response with secret-canary";
    const reply = buildExternalRunFailureReply(
      {
        message,
        error: new FailoverError(message, {
          reason: "overloaded",
          provider: "openai",
          model: "gpt-5.6-luna",
        }),
      },
      { includeDetails: false },
    );

    expect(reply.text).toBe(
      "⚠️ openai/gpt-5.6-luna request failed (provider overloaded). " +
        "This is usually temporary — try again shortly.",
    );
    expect(reply.text).not.toContain("secret-canary");
    expect(reply.text).not.toBe(GENERIC_EXTERNAL_RUN_FAILURE_TEXT);
    expect(reply.isGenericRunnerFailure).toBe(false);
  });

  it("keeps classified HTTP status facts when verbose detail is off", () => {
    const message =
      "⚠️ openai/gpt-5.6-luna request failed (provider overloaded, HTTP 503). " +
      "This is usually temporary — try again shortly.";
    const reply = buildExternalRunFailureReply(
      {
        message,
        error: new FailoverError(message, {
          reason: "overloaded",
          provider: "openai",
          model: "gpt-5.6-luna",
          status: 503,
        }),
      },
      { includeDetails: false },
    );

    expect(reply.text).toBe(
      "⚠️ The model provider returned a temporary internal error before replying. " +
        "Try again in a moment, or switch to another model if it keeps happening.",
    );
    expect(reply.isGenericRunnerFailure).toBe(false);
  });
});

describe("buildPreflightCompactionFailureText", () => {
  it("identifies timeout failures without requiring verbose error details", () => {
    expect(
      buildPreflightCompactionFailureText(
        "Preflight compaction required but failed: Compaction timed out",
      ),
    ).toBe(
      "⚠️ Context is too large and auto-compaction timed out before it could finish. " +
        "Try again, use /compact, or use /new to start a fresh session.",
    );
  });
});

// Session-hydration failures must stay visible in group chats: the group
// silent-reply policy deletes generic failure text, so a wedged session would
// otherwise fail every turn with no user-visible outcome.
describe("session transcript repair failure classification", () => {
  const HEADERLESS_TRANSCRIPT_ERROR =
    'Persisted session transcript has no session header row; run "openclaw doctor --fix" to repair it';
  const LEGACY_TRANSCRIPT_ERROR =
    "Persisted legacy session transcripts require doctor/import migration before runtime use";

  it.each([
    { name: "headerless transcript", message: HEADERLESS_TRANSCRIPT_ERROR },
    { name: "legacy transcript", message: LEGACY_TRANSCRIPT_ERROR },
  ])("classifies the $name load failure as actionable, not generic", ({ message }) => {
    const reply = buildExternalRunFailureReply(message);
    expect(reply.isGenericRunnerFailure).toBe(false);
    expect(reply.text).toContain("openclaw doctor --fix");
  });

  it("keeps the repair notice visible in group conversations", () => {
    const reply = buildExternalRunFailureReply(HEADERLESS_TRANSCRIPT_ERROR);
    const visibleText = resolveExternalRunFailureTextForConversation({
      text: reply.text,
      sessionCtx: {
        ChatType: "group",
        Provider: "telegram",
        SessionKey: "agent:main:telegram:group:example",
        Surface: "telegram",
      },
      isGenericRunnerFailure: reply.isGenericRunnerFailure,
    });
    expect(visibleText).toBe(reply.text);
  });
});
