import { describe, expect, it, vi } from "vitest";
import {
  createHeartbeatToolResponsePayload,
  type HeartbeatToolResponse,
} from "../auto-reply/heartbeat-tool-response.js";
import type { OpenClawConfig } from "../config/config.js";
import { runHeartbeatOnce, type HeartbeatDeps } from "./heartbeat-runner.js";
import { installHeartbeatRunnerTestRuntime } from "./heartbeat-runner.test-harness.js";
import {
  seedMainSessionStore,
  withTempTelegramHeartbeatSandbox,
} from "./heartbeat-runner.test-utils.js";

installHeartbeatRunnerTestRuntime();

describe("runHeartbeatOnce heartbeat response tool", () => {
  const TELEGRAM_GROUP = "-1001234567890";

  function createConfig(params: { tmpDir: string; storePath: string }): OpenClawConfig {
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
      },
      session: { store: params.storePath },
    } as OpenClawConfig;
  }

  function createDeps(params: {
    sendTelegram: ReturnType<typeof vi.fn>;
    getReplyFromConfig: HeartbeatDeps["getReplyFromConfig"];
  }): HeartbeatDeps {
    return {
      telegram: params.sendTelegram as unknown,
      getQueueSize: () => 0,
      nowMs: () => 0,
      getReplyFromConfig: params.getReplyFromConfig,
    };
  }

  async function runWithToolResponse(response: HeartbeatToolResponse) {
    return await withTempTelegramHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const cfg = createConfig({ tmpDir, storePath });
      await seedMainSessionStore(storePath, cfg, {
        lastChannel: "telegram",
        lastProvider: "telegram",
        lastTo: TELEGRAM_GROUP,
      });
      replySpy.mockResolvedValue(createHeartbeatToolResponsePayload(response));
      const sendTelegram = vi.fn().mockResolvedValue({ messageId: "m1" });

      const result = await runHeartbeatOnce({
        cfg,
        deps: createDeps({ sendTelegram, getReplyFromConfig: replySpy }),
      });

      return { result, sendTelegram, replySpy };
    });
  }

  it("treats notify=false as a quiet heartbeat ack", async () => {
    const { result, sendTelegram } = await runWithToolResponse({
      outcome: "no_change",
      notify: false,
      summary: "Nothing needs attention.",
    });

    expect(result.status).toBe("ran");
    expect(sendTelegram).not.toHaveBeenCalled();
  });

  it("delivers notificationText when notify=true", async () => {
    const { sendTelegram } = await runWithToolResponse({
      outcome: "needs_attention",
      notify: true,
      summary: "Build is blocked.",
      notificationText: "Build is blocked on missing credentials.",
      priority: "high",
    });

    expect(sendTelegram).toHaveBeenCalledTimes(1);
    expect(sendTelegram).toHaveBeenCalledWith(
      TELEGRAM_GROUP,
      "Build is blocked on missing credentials.",
      expect.any(Object),
    );
  });

  it("adds the heartbeat response tool hint to heartbeat prompts", async () => {
    await withTempTelegramHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const cfg = createConfig({ tmpDir, storePath });
      await seedMainSessionStore(storePath, cfg, {
        lastChannel: "telegram",
        lastProvider: "telegram",
        lastTo: TELEGRAM_GROUP,
      });
      replySpy.mockResolvedValue(
        createHeartbeatToolResponsePayload({
          outcome: "no_change",
          notify: false,
          summary: "Nothing needs attention.",
        }),
      );
      const sendTelegram = vi.fn().mockResolvedValue({ messageId: "m1" });

      await runHeartbeatOnce({
        cfg,
        deps: createDeps({ sendTelegram, getReplyFromConfig: replySpy }),
      });

      const calledCtx = replySpy.mock.calls[0]?.[0] as { Body?: string };
      expect(calledCtx.Body).toContain("heartbeat_respond");
      expect(calledCtx.Body).toContain("notify=false");
    });
  });
});
