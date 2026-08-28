import { describe, expect, it } from "vitest";
import { SILENT_REPLY_TOKEN } from "../tokens.js";
import {
  buildEmptyInteractiveReplyPayload,
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
