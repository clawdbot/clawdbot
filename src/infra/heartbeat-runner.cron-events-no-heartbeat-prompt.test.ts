import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as replyModule from "../auto-reply/reply.js";
import type { MoltbotConfig } from "../config/config.js";
import { resolveMainSessionKey } from "../config/sessions.js";
import { runHeartbeatOnce } from "./heartbeat-runner.js";
import { enqueueSystemEvent, resetSystemEventsForTest } from "./system-events.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createPluginRuntime } from "../plugins/runtime/index.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";
import { telegramPlugin } from "../../extensions/telegram/src/channel.js";
import { setTelegramRuntime } from "../../extensions/telegram/src/runtime.js";

// Avoid pulling optional runtime deps during isolated runs.
vi.mock("jiti", () => ({ createJiti: () => () => ({}) }));

beforeEach(() => {
  const runtime = createPluginRuntime();
  setTelegramRuntime(runtime);
  setActivePluginRegistry(
    createTestRegistry([{ pluginId: "telegram", plugin: telegramPlugin, source: "test" }]),
  );
  resetSystemEventsForTest();
});

describe("cron system events", () => {
  it("does not append heartbeat prompt for cron:* events with pending system events", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-hb-"));
    const storePath = path.join(tmpDir, "sessions.json");
    const replySpy = vi.spyOn(replyModule, "getReplyFromConfig");
    const prevTelegramToken = process.env.TELEGRAM_BOT_TOKEN;
    process.env.TELEGRAM_BOT_TOKEN = "test-token";
    try {
      const cfg: MoltbotConfig = {
        agents: {
          defaults: {
            workspace: tmpDir,
            heartbeat: { every: "5m", target: "telegram" },
          },
        },
        channels: { telegram: { botToken: "test-bot-token-123" } },
        session: { store: storePath },
      };
      const sessionKey = resolveMainSessionKey(cfg);

      await fs.writeFile(
        storePath,
        JSON.stringify(
          {
            [sessionKey]: {
              sessionId: "sid",
              updatedAt: Date.now(),
              lastChannel: "telegram",
              lastProvider: "telegram",
              lastTo: "123456",
            },
          },
          null,
          2,
        ),
      );

      // Enqueue a custom system event (simulating cron job behavior)
      enqueueSystemEvent("[DAILY_TASK] Time for focused work!", { sessionKey });

      replySpy.mockResolvedValue({ text: "I'll get started on your tasks!" });
      const sendTelegram = vi.fn().mockResolvedValue({
        messageId: "m1",
        chatId: "123456",
      });

      await runHeartbeatOnce({
        cfg,
        reason: "cron:daily-task",
        deps: {
          sendTelegram,
          getQueueSize: () => 0,
          nowMs: () => 0,
        },
      });

      // The reply should have been called with the system event text as Body (no heartbeat prompt)
      expect(replySpy).toHaveBeenCalledWith(
        expect.objectContaining({
          Body: "[DAILY_TASK] Time for focused work!", // System event IS the prompt
          Provider: "cron-event",
        }),
        expect.anything(),
        expect.anything(),
      );

      // Response should be delivered (not skipped due to HEARTBEAT_OK handling)
      expect(sendTelegram).toHaveBeenCalledTimes(1);
    } finally {
      replySpy.mockRestore();
      if (prevTelegramToken === undefined) {
        delete process.env.TELEGRAM_BOT_TOKEN;
      } else {
        process.env.TELEGRAM_BOT_TOKEN = prevTelegramToken;
      }
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("uses heartbeat prompt for cron events without pending system events", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-hb-"));
    const storePath = path.join(tmpDir, "sessions.json");
    const replySpy = vi.spyOn(replyModule, "getReplyFromConfig");
    const prevTelegramToken = process.env.TELEGRAM_BOT_TOKEN;
    process.env.TELEGRAM_BOT_TOKEN = "test-token";
    try {
      const cfg: MoltbotConfig = {
        agents: {
          defaults: {
            workspace: tmpDir,
            heartbeat: { every: "5m", target: "telegram" },
          },
        },
        channels: { telegram: { botToken: "test-bot-token-123" } },
        session: { store: storePath },
      };
      const sessionKey = resolveMainSessionKey(cfg);

      await fs.writeFile(
        storePath,
        JSON.stringify(
          {
            [sessionKey]: {
              sessionId: "sid",
              updatedAt: Date.now(),
              lastChannel: "telegram",
              lastProvider: "telegram",
              lastTo: "123456",
            },
          },
          null,
          2,
        ),
      );

      // No system events enqueued - this is a bare cron wake
      replySpy.mockResolvedValue({ text: "HEARTBEAT_OK" });
      const sendTelegram = vi.fn().mockResolvedValue({
        messageId: "m1",
        chatId: "123456",
      });

      await runHeartbeatOnce({
        cfg,
        reason: "cron:empty-job",
        deps: {
          sendTelegram,
          getQueueSize: () => 0,
          nowMs: () => 0,
        },
      });

      // The reply should have been called WITH the heartbeat prompt
      expect(replySpy).toHaveBeenCalledWith(
        expect.objectContaining({
          Body: expect.stringContaining("HEARTBEAT_OK"),
          Provider: "heartbeat",
        }),
        expect.anything(),
        expect.anything(),
      );
    } finally {
      replySpy.mockRestore();
      if (prevTelegramToken === undefined) {
        delete process.env.TELEGRAM_BOT_TOKEN;
      } else {
        process.env.TELEGRAM_BOT_TOKEN = prevTelegramToken;
      }
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("delivers cron response even if it contains HEARTBEAT_OK text", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-hb-"));
    const storePath = path.join(tmpDir, "sessions.json");
    const replySpy = vi.spyOn(replyModule, "getReplyFromConfig");
    const prevTelegramToken = process.env.TELEGRAM_BOT_TOKEN;
    process.env.TELEGRAM_BOT_TOKEN = "test-token";
    try {
      const cfg: MoltbotConfig = {
        agents: {
          defaults: {
            workspace: tmpDir,
            heartbeat: { every: "5m", target: "telegram" },
          },
        },
        channels: { telegram: { botToken: "test-bot-token-123" } },
        session: { store: storePath },
      };
      const sessionKey = resolveMainSessionKey(cfg);

      await fs.writeFile(
        storePath,
        JSON.stringify(
          {
            [sessionKey]: {
              sessionId: "sid",
              updatedAt: Date.now(),
              lastChannel: "telegram",
              lastProvider: "telegram",
              lastTo: "123456",
            },
          },
          null,
          2,
        ),
      );

      // Enqueue a system event
      enqueueSystemEvent("[BLOG_POSTS] Check for new posts", { sessionKey });

      // Agent responds with HEARTBEAT_OK (incorrectly, but we shouldn't skip it)
      replySpy.mockResolvedValue({ text: "HEARTBEAT_OK - No new posts to process." });
      const sendTelegram = vi.fn().mockResolvedValue({
        messageId: "m1",
        chatId: "123456",
      });

      await runHeartbeatOnce({
        cfg,
        reason: "cron:blog-posts",
        deps: {
          sendTelegram,
          getQueueSize: () => 0,
          nowMs: () => 0,
        },
      });

      // Response should be delivered even though it contains HEARTBEAT_OK
      // because this is a cron event, not a heartbeat
      expect(sendTelegram).toHaveBeenCalledTimes(1);
      expect(sendTelegram).toHaveBeenCalledWith(
        "123456",
        expect.stringContaining("No new posts"),
        expect.any(Object),
      );
    } finally {
      replySpy.mockRestore();
      if (prevTelegramToken === undefined) {
        delete process.env.TELEGRAM_BOT_TOKEN;
      } else {
        process.env.TELEGRAM_BOT_TOKEN = prevTelegramToken;
      }
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("uses heartbeat prompt for regular interval heartbeats", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-hb-"));
    const storePath = path.join(tmpDir, "sessions.json");
    const replySpy = vi.spyOn(replyModule, "getReplyFromConfig");
    const prevTelegramToken = process.env.TELEGRAM_BOT_TOKEN;
    process.env.TELEGRAM_BOT_TOKEN = "test-token";
    try {
      const cfg: MoltbotConfig = {
        agents: {
          defaults: {
            workspace: tmpDir,
            heartbeat: { every: "5m", target: "telegram" },
          },
        },
        channels: { telegram: { botToken: "test-bot-token-123" } },
        session: { store: storePath },
      };
      const sessionKey = resolveMainSessionKey(cfg);

      await fs.writeFile(
        storePath,
        JSON.stringify(
          {
            [sessionKey]: {
              sessionId: "sid",
              updatedAt: Date.now(),
              lastChannel: "telegram",
              lastProvider: "telegram",
              lastTo: "123456",
            },
          },
          null,
          2,
        ),
      );

      replySpy.mockResolvedValue({ text: "HEARTBEAT_OK" });
      const sendTelegram = vi.fn().mockResolvedValue({
        messageId: "m1",
        chatId: "123456",
      });

      await runHeartbeatOnce({
        cfg,
        reason: "interval", // Regular heartbeat
        deps: {
          sendTelegram,
          getQueueSize: () => 0,
          nowMs: () => 0,
        },
      });

      // Regular heartbeat should use heartbeat prompt
      expect(replySpy).toHaveBeenCalledWith(
        expect.objectContaining({
          Body: expect.stringContaining("HEARTBEAT_OK"),
          Provider: "heartbeat",
        }),
        expect.anything(),
        expect.anything(),
      );
    } finally {
      replySpy.mockRestore();
      if (prevTelegramToken === undefined) {
        delete process.env.TELEGRAM_BOT_TOKEN;
      } else {
        process.env.TELEGRAM_BOT_TOKEN = prevTelegramToken;
      }
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
