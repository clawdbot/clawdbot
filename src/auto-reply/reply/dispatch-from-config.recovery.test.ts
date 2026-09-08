import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentCommandGatewayIngressOpts } from "../../agents/command/types.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createSessionConversationTestRegistry } from "../../test-utils/session-conversation-registry.js";
import { createDispatcher, sessionStoreMocks } from "./dispatch-from-config.shared.test-harness.js";
import {
  automaticGroupReplyConfig,
  globalBeforeAll0,
  describe0BeforeEach0,
  setNoAbort,
} from "./dispatch-from-config.test-harness.js";
import { buildTestCtx } from "./test-ctx.js";

let createCommandChannelReplyCallbacks: typeof import("../../agents/command/channel-reply-callbacks.js").createCommandChannelReplyCallbacks;
let runAgentWithRecoveryChannelReply: typeof import("../../gateway/agent-turn/agent-recovery-channel-reply.js").runAgentWithRecoveryChannelReply;
beforeAll(async () => {
  await globalBeforeAll0();
  ({ createCommandChannelReplyCallbacks } =
    await import("../../agents/command/channel-reply-callbacks.js"));
  ({ runAgentWithRecoveryChannelReply } =
    await import("../../gateway/agent-turn/agent-recovery-channel-reply.js"));
});
beforeEach(describe0BeforeEach0);

const opts: AgentCommandGatewayIngressOpts = {
  message: "Continue the interrupted response.",
  allowModelOverride: false,
  agentId: "main",
  sessionId: "session",
  sessionKey: "agent:main:telegram:group:-100123:topic:42",
  runId: "recovered-run",
  mainRestartRecoveryAdmitted: true,
  channel: "telegram",
  accountId: "default",
  to: "-100123",
  threadId: 42,
  deliver: true,
  sourceReplyDeliveryMode: "automatic",
};

describe("recovered channel reply dispatch", () => {
  it.each(["off", "on", "full"] as const)(
    "uses normal progress policy and settles final delivery under verbose %s",
    async (verboseLevel) => {
      setNoAbort();
      sessionStoreMocks.currentEntry = { sessionId: "session", updatedAt: 1, verboseLevel };
      const dispatcher = createDispatcher();
      const onPartialReply = vi.fn(async () => true);
      const onToolStart = vi.fn();
      const onCompactionStart = vi.fn();
      const registry = createSessionConversationTestRegistry();
      const telegram = registry.channels.find((entry) => entry.plugin.id === "telegram");
      if (!telegram) {
        throw new Error("Missing Telegram test plugin");
      }
      telegram.plugin.streaming = {
        dispatchRecoveryReply: async (params) => {
          expect({ to: params.to, threadId: params.threadId, accountId: params.accountId }).toEqual(
            { to: "-100123", threadId: 42, accountId: "default" },
          );
          await params.dispatchReplyFromConfig({
            cfg: params.cfg,
            dispatcher,
            ctx: buildTestCtx({
              Provider: "telegram",
              Surface: "telegram",
              From: params.to,
              To: params.to,
              SessionKey: params.sessionKey,
              ChatType: "group",
              InternalTurnSource: "restart-recovery",
            }),
            replyOptions: { onPartialReply, onToolStart, onCompactionStart },
          });
        },
      };
      setActivePluginRegistry(registry);
      const run = vi.fn(async (admitted: AgentCommandGatewayIngressOpts) => {
        const callbacks = createCommandChannelReplyCallbacks({
          opts: admitted,
          cfg: automaticGroupReplyConfig,
          sessionKey: admitted.sessionKey,
          runId: "recovered-run",
          provider: "openai",
          model: "gpt-5.4",
          resolvedVerboseLevel: verboseLevel,
        });
        await callbacks.onPartialReply?.({ text: "Checking the result" });
        await callbacks.onAgentEvent?.({
          stream: "tool",
          data: { phase: "start", name: "read", toolCallId: "tool-1", args: { path: "README.md" } },
        });
        await callbacks.onAgentEvent?.({ stream: "compaction", data: { phase: "start" } });
        if (callbacks.shouldEmitToolResult?.()) {
          await callbacks.onToolResult?.({ text: "Read: README.md" });
        }
        if (callbacks.shouldEmitToolOutput?.()) {
          await callbacks.onToolResult?.({ text: "File output" });
        }
        if (!admitted.channelReply) {
          throw new Error("Recovery bypassed channel presentation");
        }
        const status = await admitted.channelReply.deliverFinal([{ text: "Finished" }]);
        expect(status.status).toBe("sent");
        expect(status.succeeded).toBe(true);
        return "settled";
      });
      await expect(
        runAgentWithRecoveryChannelReply({ opts, cfg: automaticGroupReplyConfig, run }),
      ).resolves.toBe("settled");
      expect(run).toHaveBeenCalledOnce();
      expect(onPartialReply).toHaveBeenCalled();
      expect(onCompactionStart).toHaveBeenCalledTimes(verboseLevel === "off" ? 0 : 1);
      expect(onToolStart).toHaveBeenCalledTimes(verboseLevel === "off" ? 0 : 1);
      expect(dispatcher.sendToolResult).toHaveBeenCalledTimes(
        verboseLevel === "off" ? 0 : verboseLevel === "full" ? 2 : 1,
      );
      expect(dispatcher.sendFinalReply).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ text: "Finished" }),
      );
    },
  );

  it.each([
    { mainRestartRecoveryAdmitted: false },
    { deliver: false },
    { sourceReplyDeliveryMode: "message_tool_only" as const },
  ])("preserves deliberate non-channel execution %j", async (override) => {
    const run = vi.fn(async (admitted: AgentCommandGatewayIngressOpts) => {
      expect(admitted.channelReply).toBeUndefined();
      return "settled";
    });
    await runAgentWithRecoveryChannelReply({
      opts: { ...opts, ...override },
      cfg: automaticGroupReplyConfig,
      run,
    });
    expect(run).toHaveBeenCalledOnce();
  });
});
