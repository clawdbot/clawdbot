import { afterEach, expect, it, vi } from "vitest";
import { dispatchInboundMessageWithDispatcher } from "../auto-reply/dispatch.js";
import { createHeartbeatToolResponsePayload } from "../auto-reply/heartbeat-tool-response.js";
import type { OpenClawConfig } from "../config/config.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../plugins/hook-runner-global.js";
import { addTestHook } from "../plugins/hooks.test-helpers.js";
import { getActivePluginRegistry } from "../plugins/runtime.js";
import type { PluginHookReplyDispatchContext } from "../plugins/types.js";
import { runHeartbeatOnce } from "./heartbeat-runner.js";
import { installHeartbeatRunnerTestRuntime } from "./heartbeat-runner.test-harness.js";
import {
  seedMainSessionStore,
  withTempTelegramHeartbeatSandbox,
} from "./heartbeat-runner.test-utils.js";

installHeartbeatRunnerTestRuntime();
afterEach(resetGlobalHookRunner);

it.each(["before_dispatch", "reply_dispatch"] as const)(
  "keeps %s channel takeover on user turns and outside monitoring policy",
  async (hookName) => {
    await withTempTelegramHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const cfg = {
        agents: { defaults: { workspace: tmpDir, heartbeat: { every: "5m", target: "telegram" } } },
        messages: { visibleReplies: "automatic" },
        channels: { telegram: { enabled: true, token: "test", allowFrom: ["owner"] } },
        session: { store: storePath },
      } as OpenClawConfig;
      const sessionKey = await seedMainSessionStore(storePath, cfg, {
        lastChannel: "telegram",
        lastProvider: "telegram",
        lastTo: "owner",
      });
      const registry = getActivePluginRegistry();
      if (!registry) {
        throw new Error("Expected channel registry");
      }
      const handler =
        hookName === "before_dispatch"
          ? vi.fn(async () => ({ handled: true, text: "Channel takeover" }))
          : vi.fn(async (_event: unknown, context: PluginHookReplyDispatchContext) => {
              context.dispatcher.sendFinalReply({ text: "Channel takeover" });
              return {
                handled: true,
                queuedFinal: true,
                counts: context.dispatcher.getQueuedCounts(),
              };
            });
      addTestHook({ registry, pluginId: "channel-hook-fixture", hookName, handler });
      initializeGlobalHookRunner(registry);
      replySpy.mockResolvedValue(
        createHeartbeatToolResponsePayload({
          outcome: "no_change",
          notify: false,
          summary: "Nothing to report",
        }),
      );
      const sendTelegram = vi.fn().mockResolvedValue({ messageId: "unexpected-monitor-send" });
      expect(
        (
          await runHeartbeatOnce({
            cfg,
            deps: { getReplyFromConfig: replySpy, telegram: sendTelegram, getQueueSize: () => 0 },
          })
        ).status,
      ).toBe("ran");
      expect(handler).not.toHaveBeenCalled();
      expect(replySpy).toHaveBeenCalledOnce();
      expect(sendTelegram).not.toHaveBeenCalled();

      replySpy.mockClear();
      const deliver = vi.fn(async () => ({ visibleReplySent: true }));
      await dispatchInboundMessageWithDispatcher({
        cfg,
        ctx: {
          Body: "User request",
          Provider: "telegram",
          Surface: "telegram",
          From: "owner",
          To: "owner",
          OriginatingChannel: "telegram",
          OriginatingTo: "owner",
          SessionKey: sessionKey,
          AgentId: "main",
          ChatType: "direct",
          CommandAuthorized: true,
        },
        replyResolver: replySpy,
        dispatcherOptions: { deliver },
      });
      expect(handler).toHaveBeenCalledOnce();
      expect(replySpy).not.toHaveBeenCalled();
      expect(deliver).toHaveBeenCalledWith(
        expect.objectContaining({ text: "Channel takeover" }),
        expect.anything(),
      );
    });
  },
);
