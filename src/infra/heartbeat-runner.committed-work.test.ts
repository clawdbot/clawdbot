import { afterEach, describe, expect, it, vi } from "vitest";
import type { EmbeddedAgentRunResult } from "../agents/embedded-agent-runner/types.js";
import {
  recordReplyOperationAgentTurn,
  resolveReplyOperationRunState,
} from "../auto-reply/reply/reply-operation-run-state.js";
import { createReplyOperation } from "../auto-reply/reply/reply-run-registry.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getLastHeartbeatEvent, resetHeartbeatEventsForTest } from "./heartbeat-events.js";
import { runHeartbeatOnce } from "./heartbeat-runner.js";
import { installHeartbeatRunnerTestRuntime } from "./heartbeat-runner.test-harness.js";
import {
  seedMainSessionStore,
  setHeartbeatAgentTurnStatus,
  withTempTelegramHeartbeatSandbox,
} from "./heartbeat-runner.test-utils.js";
import { resetSystemEventsForTest } from "./system-events.js";

installHeartbeatRunnerTestRuntime();
const target = "-1001234567890";

async function runCommittedWork(params: {
  result: Partial<EmbeddedAgentRunResult>;
  showOk?: boolean;
  status?: "ok" | "failed" | "cancelled" | "superseded";
  reply?: { text: string; isError?: boolean };
  threadId?: string;
  failAfterSettlement?: boolean;
}) {
  return await withTempTelegramHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
    const cfg: OpenClawConfig = {
      agents: { defaults: { workspace: tmpDir, heartbeat: { every: "5m", target: "telegram" } } },
      channels: {
        telegram: {
          botToken: "test-token",
          allowFrom: ["*"],
          heartbeat: { showOk: params.showOk ?? false },
        },
      },
      messages: { visibleReplies: "automatic" },
      session: { store: storePath },
    };
    await seedMainSessionStore(storePath, cfg, {
      lastChannel: "telegram",
      lastProvider: "telegram",
      lastTo: target,
      lastAccountId: "default",
      lastThreadId: params.threadId,
    });
    replySpy.mockImplementation(async (_ctx, opts) => {
      const state = resolveReplyOperationRunState(opts);
      if (!state) {
        throw new Error("Heartbeat invocation state missing");
      }
      const owner = createReplyOperation({
        sessionKey: "heartbeat-committed-work",
        sessionId: "heartbeat-committed-work",
        turnKind: "heartbeat",
        resetTriggered: false,
      });
      recordReplyOperationAgentTurn([state], owner, {
        kind: "settled",
        status: "ok",
        result: params.result,
      });
      if (params.failAfterSettlement) {
        recordReplyOperationAgentTurn([state], owner);
      }
      owner.complete();
      if (params.status) {
        setHeartbeatAgentTurnStatus(opts, params.status);
      }
      return params.reply ?? { text: "NO_REPLY" };
    });
    const send = vi.fn().mockResolvedValue({ messageId: "new-message" });
    const result = await runHeartbeatOnce({
      cfg,
      deps: { telegram: send, getQueueSize: () => 0, getReplyFromConfig: replySpy },
    });
    return { result, event: getLastHeartbeatEvent(), send };
  });
}

describe("heartbeat committed work bookkeeping", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    resetHeartbeatEventsForTest();
    resetSystemEventsForTest();
  });

  it.each([false, true])(
    "records a confirmed send without another acknowledgement (showOk=%s)",
    async (showOk) => {
      const { event, send } = await runCommittedWork({
        showOk,
        result: {
          messagingToolSentTargets: [
            { tool: "message", provider: "telegram", to: target, text: "Delivered alert" },
          ],
        },
      });
      expect(event).toMatchObject({ status: "sent", silent: false, preview: "Delivered alert" });
      expect(send).not.toHaveBeenCalled();
    },
  );

  it.each([
    { name: "media", evidence: { mediaUrls: ["https://example.com/chart.png"] }, hasMedia: true },
    { name: "rich content", evidence: { hasRichContent: true as const }, hasMedia: false },
  ])("records a confirmed $name send without requiring text", async ({ evidence, hasMedia }) => {
    const { event, send } = await runCommittedWork({
      result: {
        messagingToolSentTargets: [
          { tool: "message", provider: "telegram", to: target, ...evidence },
        ],
      },
    });
    expect(event).toMatchObject({ status: "sent", silent: false, hasMedia });
    expect(send).not.toHaveBeenCalled();
  });

  it.each([
    { name: "recipient", to: "-1009999999999" },
    { name: "account", accountId: "other" },
    { name: "topic", threadId: "8" },
  ])("does not credit delivery to another $name", async ({ name: _name, ...route }) => {
    const { event, send } = await runCommittedWork({
      threadId: "7",
      result: {
        messagingToolSentTargets: [
          {
            tool: "message",
            provider: "telegram",
            to: target,
            accountId: "default",
            threadId: "7",
            text: "Other route",
            ...route,
          },
        ],
      },
    });
    expect(event).toMatchObject({ status: "ok-token", silent: true });
    expect(send).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "child",
      result: {
        acceptedSessionSpawns: [
          {
            runId: "child",
            childSessionKey: "agent:main:subagent:child",
            expectsCompletionMessage: true,
          },
        ],
      },
    },
    { name: "async tool", result: { asyncWorkStarted: true as const } },
  ])("distinguishes started $name work from an all-clear acknowledgement", async ({ result }) => {
    const { event, send } = await runCommittedWork({ result, showOk: true });
    expect(event).toMatchObject({ status: "skipped", reason: "background-work", silent: true });
    expect(send).not.toHaveBeenCalled();
  });

  it.each(["failed", "cancelled", "superseded"] as const)(
    "preserves %s after a prior send",
    async (status) => {
      const { result, event } = await runCommittedWork({
        status,
        result: {
          messagingToolSentTargets: [
            { tool: "message", provider: "telegram", to: target, text: "Earlier progress" },
          ],
        },
      });
      expect(result.status).toBe(status === "failed" ? "failed" : "skipped");
      expect(event?.status).toBe(status === "failed" ? "failed" : "skipped");
      if (status === "failed") {
        expect(event?.silent).toBe(false);
      }
    },
  );

  it("retains committed evidence if the same invocation fails after settlement", async () => {
    const { result, event } = await runCommittedWork({
      failAfterSettlement: true,
      result: {
        messagingToolSentTargets: [
          { tool: "message", provider: "telegram", to: target, text: "Earlier progress" },
        ],
      },
    });
    expect(result.status).toBe("failed");
    expect(event).toMatchObject({ status: "failed", silent: false });
  });

  it("preserves a distinct final alert after a committed progress message", async () => {
    const { event, send } = await runCommittedWork({
      reply: { text: "Final alert" },
      result: {
        messagingToolSentTargets: [
          { tool: "message", provider: "telegram", to: target, text: "Earlier progress" },
        ],
      },
    });
    expect(event).toMatchObject({ status: "sent", preview: "Final alert" });
    expect(send).toHaveBeenCalledOnce();
  });

  it.each([
    {},
    { didSendViaMessagingTool: true, messagingToolSentTexts: ["Unscoped delivery"] },
    { meta: { durationMs: 1, toolSummary: { calls: 1, tools: ["image_generate"] } } },
  ])("keeps unconfirmed delivery or work evidence quiet (%j)", async (result) => {
    const { event, send } = await runCommittedWork({ result });
    expect(event).toMatchObject({ status: "ok-token", silent: true });
    expect(send).not.toHaveBeenCalled();
  });
});
