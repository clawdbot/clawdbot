import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createHeartbeatToolResponsePayload,
  type HeartbeatToolResponse,
} from "../auto-reply/heartbeat-tool-response.js";
import { markReplyPayloadForSourceSuppressionDelivery } from "../auto-reply/types.js";
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

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function createConfig(params: {
    tmpDir: string;
    storePath: string;
    visibleReplies?: "automatic" | "message_tool";
    agentRuntimeId?: string;
    model?: string;
  }): OpenClawConfig {
    return {
      agents: {
        defaults: {
          workspace: params.tmpDir,
          heartbeat: { every: "5m", target: "telegram" },
          ...(params.model ? { model: params.model } : {}),
          ...(params.agentRuntimeId ? { agentRuntime: { id: params.agentRuntimeId } } : {}),
        },
      },
      ...(params.visibleReplies ? { messages: { visibleReplies: params.visibleReplies } } : {}),
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

  it("uses the heartbeat response tool prompt in message-tool mode", async () => {
    await withTempTelegramHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const cfg = createConfig({ tmpDir, storePath, visibleReplies: "message_tool" });
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
      const calledOpts = replySpy.mock.calls[0]?.[1] as {
        enableHeartbeatTool?: boolean;
        forceHeartbeatTool?: boolean;
        sourceReplyDeliveryMode?: string;
      };
      expect(calledCtx.Body).toContain("heartbeat_respond");
      expect(calledCtx.Body).toContain("notify=false");
      expect(calledCtx.Body).not.toContain("HEARTBEAT_OK");
      expect(calledOpts.enableHeartbeatTool).toBe(true);
      expect(calledOpts.forceHeartbeatTool).toBe(true);
      expect(calledOpts.sourceReplyDeliveryMode).toBe("message_tool_only");
    });
  });

  it("uses the heartbeat response tool prompt for Codex harness sessions by default", async () => {
    await withTempTelegramHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const cfg = createConfig({ tmpDir, storePath });
      await seedMainSessionStore(storePath, cfg, {
        lastChannel: "telegram",
        lastProvider: "telegram",
        lastTo: TELEGRAM_GROUP,
        agentHarnessId: "codex",
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
      const calledOpts = replySpy.mock.calls[0]?.[1] as {
        enableHeartbeatTool?: boolean;
        forceHeartbeatTool?: boolean;
        sourceReplyDeliveryMode?: string;
      };
      expect(calledCtx.Body).toContain("heartbeat_respond");
      expect(calledCtx.Body).not.toContain("HEARTBEAT_OK");
      expect(calledOpts.enableHeartbeatTool).toBe(true);
      expect(calledOpts.forceHeartbeatTool).toBe(true);
      expect(calledOpts.sourceReplyDeliveryMode).toBe("message_tool_only");
    });
  });

  it("delivers Codex runtime failure notices during Codex heartbeat message-tool mode", async () => {
    await withTempTelegramHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const cfg = createConfig({ tmpDir, storePath });
      await seedMainSessionStore(storePath, cfg, {
        lastChannel: "telegram",
        lastProvider: "telegram",
        lastTo: TELEGRAM_GROUP,
        agentHarnessId: "codex",
      });
      const usageLimitMessage =
        "⚠️ You've reached your Codex subscription usage limit. Next reset in 42 minutes (2026-05-04T21:34:00.000Z). Run /codex account for current usage details.";
      replySpy.mockResolvedValue(
        markReplyPayloadForSourceSuppressionDelivery({
          text: usageLimitMessage,
          isError: true,
        }),
      );
      const sendTelegram = vi.fn().mockResolvedValue({ messageId: "m1" });

      const result = await runHeartbeatOnce({
        cfg,
        deps: createDeps({ sendTelegram, getReplyFromConfig: replySpy }),
      });

      const calledOpts = replySpy.mock.calls[0]?.[1] as {
        sourceReplyDeliveryMode?: string;
      };
      expect(result.status).toBe("ran");
      expect(calledOpts.sourceReplyDeliveryMode).toBe("message_tool_only");
      expect(sendTelegram).toHaveBeenCalledTimes(1);
      expect(sendTelegram).toHaveBeenCalledWith(
        TELEGRAM_GROUP,
        usageLimitMessage,
        expect.any(Object),
      );
    });
  });

  it("uses the heartbeat response tool prompt for auto-selected Codex model sessions", async () => {
    await withTempTelegramHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const cfg = createConfig({
        tmpDir,
        storePath,
        agentRuntimeId: "auto",
        model: "codex/gpt-5.5",
      });
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
      const calledOpts = replySpy.mock.calls[0]?.[1] as {
        enableHeartbeatTool?: boolean;
        forceHeartbeatTool?: boolean;
        sourceReplyDeliveryMode?: string;
      };
      expect(calledCtx.Body).toContain("heartbeat_respond");
      expect(calledCtx.Body).not.toContain("HEARTBEAT_OK");
      expect(calledOpts.enableHeartbeatTool).toBe(true);
      expect(calledOpts.forceHeartbeatTool).toBe(true);
      expect(calledOpts.sourceReplyDeliveryMode).toBe("message_tool_only");
    });
  });

  it("uses the heartbeat response tool prompt when the Codex runtime is env-forced", async () => {
    vi.stubEnv("OPENCLAW_AGENT_RUNTIME", "codex");
    await withTempTelegramHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const cfg = createConfig({ tmpDir, storePath, model: "openai/gpt-5.5" });
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
      const calledOpts = replySpy.mock.calls[0]?.[1] as {
        enableHeartbeatTool?: boolean;
        forceHeartbeatTool?: boolean;
        sourceReplyDeliveryMode?: string;
      };
      expect(calledCtx.Body).toContain("heartbeat_respond");
      expect(calledCtx.Body).not.toContain("HEARTBEAT_OK");
      expect(calledOpts.enableHeartbeatTool).toBe(true);
      expect(calledOpts.forceHeartbeatTool).toBe(true);
      expect(calledOpts.sourceReplyDeliveryMode).toBe("message_tool_only");
    });
  });

  it("uses the heartbeat response tool prompt for due heartbeat tasks", async () => {
    await withTempTelegramHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const cfg = createConfig({ tmpDir, storePath, visibleReplies: "message_tool" });
      await fs.writeFile(
        path.join(tmpDir, "HEARTBEAT.md"),
        `tasks:
  - name: status
    interval: 1m
    prompt: Check deployment status
`,
        "utf-8",
      );
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
      const calledOpts = replySpy.mock.calls[0]?.[1] as {
        enableHeartbeatTool?: boolean;
        forceHeartbeatTool?: boolean;
        sourceReplyDeliveryMode?: string;
      };
      expect(calledCtx.Body).toContain("Run the following periodic tasks");
      expect(calledCtx.Body).toContain("Check deployment status");
      expect(calledCtx.Body).toContain("heartbeat_respond");
      expect(calledCtx.Body).not.toContain("HEARTBEAT_OK");
      expect(calledOpts.enableHeartbeatTool).toBe(true);
      expect(calledOpts.forceHeartbeatTool).toBe(true);
      expect(calledOpts.sourceReplyDeliveryMode).toBe("message_tool_only");
    });
  });

  it("keeps the legacy heartbeat ok prompt outside heartbeat response tool mode", async () => {
    await withTempTelegramHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const cfg = createConfig({ tmpDir, storePath, visibleReplies: "automatic" });
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
      const calledOpts = replySpy.mock.calls[0]?.[1] as {
        enableHeartbeatTool?: boolean;
        forceHeartbeatTool?: boolean;
        sourceReplyDeliveryMode?: string;
      };
      expect(calledCtx.Body).toContain("HEARTBEAT_OK");
      expect(calledCtx.Body).not.toContain("heartbeat_respond");
      expect(calledOpts.enableHeartbeatTool).toBeUndefined();
      expect(calledOpts.forceHeartbeatTool).toBeUndefined();
      expect(calledOpts.sourceReplyDeliveryMode).toBeUndefined();
    });
  });
});
