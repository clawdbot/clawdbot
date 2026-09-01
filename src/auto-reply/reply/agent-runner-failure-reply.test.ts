import { describe, expect, it } from "vitest";
import { FailoverError } from "../../agents/failover-error.js";
import { GENERIC_EXTERNAL_RUN_FAILURE_TEXT } from "../../agents/failover/user-copy.js";
import { SILENT_REPLY_TOKEN } from "../tokens.js";
import {
  buildEmptyInteractiveReplyPayload,
  buildExternalRunFailureReply,
  buildPreflightCompactionFailureText,
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
