import { describe, expect, it } from "vitest";
import { UNRESOLVED_TOKEN_PREFLIGHT_COMPACTION_REASON } from "../../agents/embedded-agent-runner/compact-reasons.js";
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
  it("shows the unresolved cause and a working remedy in the default reply", () => {
    // Regression for #121617 review: the unresolved token-preflight state
    // cannot be recovered by retrying or /compact, so the default (non-
    // verbose) reply must carry the cause and point at /new instead of the
    // generic advice.
    const text = buildPreflightCompactionFailureText(
      `Preflight compaction required but failed: ${UNRESOLVED_TOKEN_PREFLIGHT_COMPACTION_REASON}`,
    );

    expect(text).toContain("even after compaction");
    expect(text).toContain("nothing new can be compacted");
    expect(text).toContain("/new");
    expect(text).not.toContain("Try again, use /compact");
  });

  it("keeps the generic copy for other preflight compaction failures", () => {
    const text = buildPreflightCompactionFailureText(
      "Preflight compaction required but failed: auth profile mismatch",
    );

    expect(text).toContain("auto-compaction could not recover this turn");
    expect(text).toContain("/compact");
    expect(text).toContain("/new");
  });

  it("returns null for non-preflight messages", () => {
    expect(buildPreflightCompactionFailureText("some other failure")).toBeNull();
  });
});
