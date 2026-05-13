import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { runHeartbeatOnce, type HeartbeatDeps } from "./heartbeat-runner.js";
import { installHeartbeatRunnerTestRuntime } from "./heartbeat-runner.test-harness.js";
import {
  seedMainSessionStore,
  withTempTelegramHeartbeatSandbox,
} from "./heartbeat-runner.test-utils.js";

installHeartbeatRunnerTestRuntime();

describe("runHeartbeatOnce responsePrefix templates", () => {
  const TELEGRAM_GROUP = "-1001234567890";

  function createTelegramHeartbeatConfig(params: {
    tmpDir: string;
    storePath: string;
    responsePrefix: string;
  }): OpenClawConfig {
    return {
      agents: {
        defaults: {
          workspace: params.tmpDir,
          heartbeat: { every: "5m", target: "telegram" },
        },
      },
      channels: {
        telegram: {
          token: "test-token",
          allowFrom: ["*"],
          heartbeat: { showOk: false },
        },
      } as never,
      messages: { responsePrefix: params.responsePrefix },
      session: { store: params.storePath },
    };
  }

  function makeTelegramDeps(params: { sendTelegram: ReturnType<typeof vi.fn> }): HeartbeatDeps {
    return {
      telegram: params.sendTelegram as unknown,
      getQueueSize: () => 0,
      nowMs: () => 0,
    } satisfies HeartbeatDeps;
  }

  function createMessageSendSpy() {
    return vi.fn().mockResolvedValue({
      messageId: "m1",
      chatId: TELEGRAM_GROUP,
    });
  }

  function requireFirstMockCall<T>(mock: { mock: { calls: T[][] } }, label: string): T[] {
    const call = mock.mock.calls[0];
    if (!call) {
      throw new Error(`expected ${label} call`);
    }
    return call;
  }

  async function runTemplatedHeartbeat(params: { responsePrefix: string; replyText: string }) {
    return withTempTelegramHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const cfg = createTelegramHeartbeatConfig({
        tmpDir,
        storePath,
        responsePrefix: params.responsePrefix,
      });
      await seedMainSessionStore(storePath, cfg, {
        lastChannel: "telegram",
        lastProvider: "telegram",
        lastTo: TELEGRAM_GROUP,
      });

      replySpy.mockImplementation(async (_ctx, opts) => {
        opts?.onModelSelected?.({
          provider: "openai-codex",
          model: "gpt-5.4-20260401",
          thinkLevel: "high",
        });
        return { text: params.replyText };
      });
      const sendTelegram = createMessageSendSpy();

      await runHeartbeatOnce({
        cfg,
        deps: {
          ...makeTelegramDeps({ sendTelegram }),
          getReplyFromConfig: replySpy,
        },
      });

      return sendTelegram;
    });
  }

  it("resolves responsePrefix model-selection variables before alert delivery", async () => {
    const sendTelegram = await runTemplatedHeartbeat({
      responsePrefix: "[{provider}/{model}|think:{thinkingLevel}]",
      replyText: "Heartbeat alert",
    });

    expect(sendTelegram).toHaveBeenCalledTimes(1);
    const [target, message, options] = requireFirstMockCall(sendTelegram, "telegram send");
    expect(target).toBe(TELEGRAM_GROUP);
    expect(message).toBe("[openai-codex/gpt-5.4|think:high] Heartbeat alert");
    expect(typeof options).toBe("object");
  });

  it("uses the resolved responsePrefix when suppressing prefixed HEARTBEAT_OK replies", async () => {
    const sendTelegram = await runTemplatedHeartbeat({
      responsePrefix: "[{model}]",
      replyText: "[gpt-5.4] HEARTBEAT_OK all good",
    });

    expect(sendTelegram).not.toHaveBeenCalled();
  });
});
