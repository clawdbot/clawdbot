import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import * as replyModule from "../auto-reply/reply.js";
import type { ClawdbotConfig } from "../config/config.js";
import { runHeartbeatOnce } from "./heartbeat-runner.js";

// Avoid pulling optional runtime deps during isolated runs.
vi.mock("jiti", () => ({ createJiti: () => () => ({}) }));

describe("resolveHeartbeatIntervalMs", () => {
  it("respects ackMaxChars for heartbeat acks", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-hb-"));
    const storePath = path.join(tmpDir, "sessions.json");
    const replySpy = vi.spyOn(replyModule, "getReplyFromConfig");
    try {
      await fs.writeFile(
        storePath,
        JSON.stringify(
          {
            main: {
              sessionId: "sid",
              updatedAt: Date.now(),
              lastProvider: "whatsapp",
              lastTo: "+1555",
            },
          },
          null,
          2,
        ),
      );

      const cfg: ClawdbotConfig = {
        agents: {
          defaults: {
            heartbeat: {
              every: "5m",
              target: "whatsapp",
              to: "+1555",
              ackMaxChars: 0,
            },
          },
        },
        channels: { whatsapp: { allowFrom: ["*"] } },
        session: { store: storePath },
      };

      replySpy.mockResolvedValue({ text: "HEARTBEAT_OK 🦞" });
      const sendWhatsApp = vi.fn().mockResolvedValue({
        messageId: "m1",
        toJid: "jid",
      });

      await runHeartbeatOnce({
        cfg,
        deps: {
          sendWhatsApp,
          getQueueSize: () => 0,
          nowMs: () => 0,
          webAuthExists: async () => true,
          hasActiveWebListener: () => true,
        },
      });

      expect(sendWhatsApp).toHaveBeenCalled();
    } finally {
      replySpy.mockRestore();
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("skips delivery for markup-wrapped HEARTBEAT_OK", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-hb-"));
    const storePath = path.join(tmpDir, "sessions.json");
    const replySpy = vi.spyOn(replyModule, "getReplyFromConfig");
    try {
      await fs.writeFile(
        storePath,
        JSON.stringify(
          {
            main: {
              sessionId: "sid",
              updatedAt: Date.now(),
              lastProvider: "whatsapp",
              lastTo: "+1555",
            },
          },
          null,
          2,
        ),
      );

      const cfg: ClawdbotConfig = {
        agents: {
          defaults: {
            heartbeat: {
              every: "5m",
              target: "whatsapp",
              to: "+1555",
            },
          },
        },
        channels: { whatsapp: { allowFrom: ["*"] } },
        session: { store: storePath },
      };

      replySpy.mockResolvedValue({ text: "<b>HEARTBEAT_OK</b>" });
      const sendWhatsApp = vi.fn().mockResolvedValue({
        messageId: "m1",
        toJid: "jid",
      });

      await runHeartbeatOnce({
        cfg,
        deps: {
          sendWhatsApp,
          getQueueSize: () => 0,
          nowMs: () => 0,
          webAuthExists: async () => true,
          hasActiveWebListener: () => true,
        },
      });

      expect(sendWhatsApp).not.toHaveBeenCalled();
    } finally {
      replySpy.mockRestore();
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("does not regress updatedAt when restoring heartbeat sessions", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-hb-"));
    const storePath = path.join(tmpDir, "sessions.json");
    const replySpy = vi.spyOn(replyModule, "getReplyFromConfig");
    try {
      const originalUpdatedAt = 1000;
      const bumpedUpdatedAt = 2000;
      await fs.writeFile(
        storePath,
        JSON.stringify(
          {
            main: {
              sessionId: "sid",
              updatedAt: originalUpdatedAt,
              lastProvider: "whatsapp",
              lastTo: "+1555",
            },
          },
          null,
          2,
        ),
      );

      const cfg: ClawdbotConfig = {
        agents: {
          defaults: {
            heartbeat: {
              every: "5m",
              target: "whatsapp",
              to: "+1555",
            },
          },
        },
        channels: { whatsapp: { allowFrom: ["*"] } },
        session: { store: storePath },
      };

      replySpy.mockImplementationOnce(async () => {
        const raw = await fs.readFile(storePath, "utf-8");
        const parsed = JSON.parse(raw) as { main?: { updatedAt?: number } };
        if (parsed.main) {
          parsed.main.updatedAt = bumpedUpdatedAt;
        }
        await fs.writeFile(storePath, JSON.stringify(parsed, null, 2));
        return { text: "" };
      });

      await runHeartbeatOnce({
        cfg,
        deps: {
          getQueueSize: () => 0,
          nowMs: () => 0,
          webAuthExists: async () => true,
          hasActiveWebListener: () => true,
        },
      });

      const finalStore = JSON.parse(await fs.readFile(storePath, "utf-8")) as {
        main?: { updatedAt?: number };
      };
      expect(finalStore.main?.updatedAt).toBe(bumpedUpdatedAt);
    } finally {
      replySpy.mockRestore();
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("skips WhatsApp delivery when not linked or running", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-hb-"));
    const storePath = path.join(tmpDir, "sessions.json");
    const replySpy = vi.spyOn(replyModule, "getReplyFromConfig");
    try {
      await fs.writeFile(
        storePath,
        JSON.stringify(
          {
            main: {
              sessionId: "sid",
              updatedAt: Date.now(),
              lastProvider: "whatsapp",
              lastTo: "+1555",
            },
          },
          null,
          2,
        ),
      );

      const cfg: ClawdbotConfig = {
        agents: {
          defaults: {
            heartbeat: { every: "5m", target: "whatsapp", to: "+1555" },
          },
        },
        channels: { whatsapp: { allowFrom: ["*"] } },
        session: { store: storePath },
      };

      replySpy.mockResolvedValue({ text: "Heartbeat alert" });
      const sendWhatsApp = vi.fn().mockResolvedValue({
        messageId: "m1",
        toJid: "jid",
      });

      const res = await runHeartbeatOnce({
        cfg,
        deps: {
          sendWhatsApp,
          getQueueSize: () => 0,
          nowMs: () => 0,
          webAuthExists: async () => false,
          hasActiveWebListener: () => false,
        },
      });

      expect(res.status).toBe("skipped");
      expect(res).toMatchObject({ reason: "whatsapp-not-linked" });
      expect(sendWhatsApp).not.toHaveBeenCalled();
    } finally {
      replySpy.mockRestore();
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("passes through accountId for telegram heartbeats", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-hb-"));
    const storePath = path.join(tmpDir, "sessions.json");
    const replySpy = vi.spyOn(replyModule, "getReplyFromConfig");
    const prevTelegramToken = process.env.TELEGRAM_BOT_TOKEN;
    process.env.TELEGRAM_BOT_TOKEN = "";
    try {
      await fs.writeFile(
        storePath,
        JSON.stringify(
          {
            main: {
              sessionId: "sid",
              updatedAt: Date.now(),
              lastProvider: "telegram",
              lastTo: "123456",
            },
          },
          null,
          2,
        ),
      );

      const cfg: ClawdbotConfig = {
        agents: {
          defaults: {
            heartbeat: { every: "5m", target: "telegram", to: "123456" },
          },
        },
        channels: { telegram: { botToken: "test-bot-token-123" } },
        session: { store: storePath },
      };

      replySpy.mockResolvedValue({ text: "Hello from heartbeat" });
      const sendTelegram = vi.fn().mockResolvedValue({
        messageId: "m1",
        chatId: "123456",
      });

      await runHeartbeatOnce({
        cfg,
        deps: {
          sendTelegram,
          getQueueSize: () => 0,
          nowMs: () => 0,
        },
      });

      expect(sendTelegram).toHaveBeenCalledTimes(1);
      expect(sendTelegram).toHaveBeenCalledWith(
        "123456",
        "Hello from heartbeat",
        expect.objectContaining({ accountId: undefined, verbose: false }),
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

  it("does not pre-resolve telegram accountId (allows config-only account tokens)", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-hb-"));
    const storePath = path.join(tmpDir, "sessions.json");
    const replySpy = vi.spyOn(replyModule, "getReplyFromConfig");
    const prevTelegramToken = process.env.TELEGRAM_BOT_TOKEN;
    process.env.TELEGRAM_BOT_TOKEN = "";
    try {
      await fs.writeFile(
        storePath,
        JSON.stringify(
          {
            main: {
              sessionId: "sid",
              updatedAt: Date.now(),
              lastProvider: "telegram",
              lastTo: "123456",
            },
          },
          null,
          2,
        ),
      );

      const cfg: ClawdbotConfig = {
        agents: {
          defaults: {
            heartbeat: { every: "5m", target: "telegram", to: "123456" },
          },
        },
        channels: {
          telegram: {
            accounts: {
              work: { botToken: "test-bot-token-123" },
            },
          },
        },
        session: { store: storePath },
      };

      replySpy.mockResolvedValue({ text: "Hello from heartbeat" });
      const sendTelegram = vi.fn().mockResolvedValue({
        messageId: "m1",
        chatId: "123456",
      });

      await runHeartbeatOnce({
        cfg,
        deps: {
          sendTelegram,
          getQueueSize: () => 0,
          nowMs: () => 0,
        },
      });

      expect(sendTelegram).toHaveBeenCalledTimes(1);
      expect(sendTelegram).toHaveBeenCalledWith(
        "123456",
        "Hello from heartbeat",
        expect.objectContaining({ accountId: undefined, verbose: false }),
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
