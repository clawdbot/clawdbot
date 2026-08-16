/** Covers steer finalize audit honesty: aborted unconfirmed commits must not audit as completed. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { emitInboundMessageAuditTerminal } from "../../auto-reply/reply/dispatch-from-config.audit.js";
import {
  abortReplyMessageInjectionTarget,
  recordAcceptedReplyMessageInjectionTarget,
  type ReplyMessageInjectionOutcome,
  type ReplyMessageInjectionTarget,
} from "../../auto-reply/reply/reply-run-registry.js";
import { updateSessionEntry } from "../../config/sessions/session-accessor.js";
import { logMessageProcessed } from "../../logging/diagnostic.js";
import { finalizeAcceptedChatSendMessageInjection } from "./chat-send-message-injection.js";
import type { GatewayRequestContext } from "./types.js";

vi.mock("../../auto-reply/reply/dispatch-from-config.audit.js", () => ({
  emitInboundMessageAuditTerminal: vi.fn(),
}));
vi.mock("../../auto-reply/reply/reply-run-registry.js", () => ({
  abortReplyMessageInjectionTarget: vi.fn(() => true),
  beginReplyMessageInjectionTarget: vi.fn(),
  recordAcceptedReplyMessageInjectionTarget: vi.fn(),
}));
vi.mock("../../auto-reply/reply/message-received-hooks.js", () => ({
  emitMessageReceivedHooks: vi.fn(),
}));
vi.mock("../../config/sessions/session-accessor.js", () => ({
  updateSessionEntry: vi.fn(async () => undefined),
}));
vi.mock("../../logging/diagnostic.js", () => ({
  logMessageProcessed: vi.fn(),
  logMessageReceived: vi.fn(),
}));
vi.mock("../../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: vi.fn(() => undefined),
}));
vi.mock("./chat-broadcast.js", () => ({
  broadcastChatFinal: vi.fn(),
}));
vi.mock("../agent-turn/agent-job.js", () => ({
  setGatewayDedupeEntry: vi.fn(),
}));

function makeParams(outcome: Extract<ReplyMessageInjectionOutcome, { status: "accepted" }>) {
  const context = {
    logGateway: { warn: vi.fn() },
    chatRunState: { hasAbortMarker: () => true },
    dedupe: new Map(),
  } as unknown as GatewayRequestContext;
  return {
    context,
    ctx: { Provider: "dashboard", From: "user", To: "user", Body: "steer" },
    outcome,
    persistUserTurnTranscriptBestEffort: vi.fn(async () => undefined),
    session: {
      agentId: "main",
      cfg: {},
      clientRunId: "run-1",
      entry: undefined,
      sessionKey: "agent:main:dashboard:s",
      storePath: "/tmp/nowhere.json",
    },
    startedAt: Date.now(),
    target: {} as ReplyMessageInjectionTarget,
    targetRunId: "run-1",
  } as unknown as Parameters<typeof finalizeAcceptedChatSendMessageInjection>[0];
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("finalizeAcceptedChatSendMessageInjection", () => {
  it("audits a confirmed steer as completed active_run_injected", async () => {
    await finalizeAcceptedChatSendMessageInjection(
      makeParams({ status: "accepted", result: undefined } as never),
    );

    expect(abortReplyMessageInjectionTarget).not.toHaveBeenCalled();
    expect(recordAcceptedReplyMessageInjectionTarget).toHaveBeenCalledOnce();
    expect(logMessageProcessed).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "completed", reason: "active_run_injected" }),
    );
    expect(emitInboundMessageAuditTerminal).toHaveBeenCalledWith(
      expect.objectContaining({
        terminal: { outcome: "completed", options: { reason: "active_run_injected" } },
      }),
    );
    expect(updateSessionEntry).toHaveBeenCalledOnce();
  });

  it("audits an unconfirmed-transcript steer abort as skipped, not completed", async () => {
    await finalizeAcceptedChatSendMessageInjection(
      makeParams({
        status: "accepted",
        result: { transcriptCommit: "unconfirmed", errorMessage: "commit timeout" },
      } as never),
    );

    expect(abortReplyMessageInjectionTarget).toHaveBeenCalledOnce();
    expect(logMessageProcessed).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "skipped", reason: "reply_operation_aborted" }),
    );
    expect(emitInboundMessageAuditTerminal).toHaveBeenCalledWith(
      expect.objectContaining({
        terminal: { outcome: "skipped", options: { reason: "reply_operation_aborted" } },
      }),
    );
  });
});
