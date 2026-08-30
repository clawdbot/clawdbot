import { describe, expect, it } from "vitest";
import { PluginHarnessSourceFinalizationUnsupportedError } from "../../agents/harness/errors.js";
import { SILENT_REPLY_TOKEN } from "../tokens.js";
import {
  buildExternalRunFailureReply,
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

describe("buildExternalRunFailureReply", () => {
  it("surfaces the exact recovery for an unsupported Matrix freshness runtime", () => {
    const error = new PluginHarnessSourceFinalizationUnsupportedError("copilot");

    expect(buildExternalRunFailureReply({ message: error.message, error })).toEqual({
      text:
        "⚠️ The selected plugin agent runtime does not support Matrix fresh-message redraft and discard, so it was not started. " +
        "Use OpenClaw's registry-attested bundled Codex harness for plugin-harness freshness, select a supported embedded or CLI runtime, or set " +
        "channels.matrix.turnTaking.redraftDepth to 0 for participation-only mode.",
      isGenericRunnerFailure: false,
    });
  });
});
