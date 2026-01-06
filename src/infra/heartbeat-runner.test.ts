import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { HEARTBEAT_PROMPT } from "../auto-reply/heartbeat.js";
import * as replyModule from "../auto-reply/reply.js";
import type { ClawdbotConfig } from "../config/config.js";
import {
  resolveHeartbeatDeliveryTarget,
  resolveHeartbeatIntervalMs,
  resolveHeartbeatPrompt,
  runHeartbeatOnce,
} from "./heartbeat-runner.js";

describe("resolveHeartbeatIntervalMs", () => {
  it("returns null when unset or invalid", () => {
    expect(resolveHeartbeatIntervalMs({})).toBeNull();
    expect(
      resolveHeartbeatIntervalMs({ agent: { heartbeat: { every: "0m" } } }),
    ).toBeNull();
    expect(
      resolveHeartbeatIntervalMs({ agent: { heartbeat: { every: "oops" } } }),
    ).toBeNull();
  });

  it("parses duration strings with minute defaults", () => {
    expect(
      resolveHeartbeatIntervalMs({ agent: { heartbeat: { every: "5m" } } }),
    ).toBe(5 * 60_000);
    expect(
      resolveHeartbeatIntervalMs({ agent: { heartbeat: { every: "5" } } }),
    ).toBe(5 * 60_000);
    expect(
      resolveHeartbeatIntervalMs({ agent: { heartbeat: { every: "2h" } } }),
    ).toBe(2 * 60 * 60_000);
  });
});

describe("resolveHeartbeatPrompt", () => {
  it("uses the default prompt when unset", () => {
    expect(resolveHeartbeatPrompt({})).toBe(HEARTBEAT_PROMPT);
  });

  it("uses a trimmed override when configured", () => {
    const cfg: ClawdbotConfig = {
      agent: { heartbeat: { prompt: "  ping  " } },
    };
    expect(resolveHeartbeatPrompt(cfg)).toBe("ping");
  });
});

describe("resolveHeartbeatDeliveryTarget", () => {
  const baseEntry = {
    sessionId: "sid",
    updatedAt: Date.now(),
  };

  it("respects target none", () => {
    const cfg: ClawdbotConfig = {
      agent: { heartbeat: { target: "none" } },
    };
    expect(resolveHeartbeatDeliveryTarget({ cfg, entry: baseEntry })).toEqual({
      channel: "none",
      reason: "target-none",
    });
  });

  it("uses last route by default", () => {
    const cfg: ClawdbotConfig = {};
    const entry = {
      ...baseEntry,
      lastChannel: "whatsapp" as const,
      lastTo: "+1555",
    };
    expect(resolveHeartbeatDeliveryTarget({ cfg, entry })).toEqual({
      channel: "whatsapp",
      to: "+1555",
    });
  });

  it("skips when last route is webchat", () => {
    const cfg: ClawdbotConfig = {};
    const entry = {
      ...baseEntry,
      lastChannel: "webchat" as const,
      lastTo: "web",
    };
    expect(resolveHeartbeatDeliveryTarget({ cfg, entry })).toEqual({
      channel: "none",
      reason: "no-target",
    });
  });

  it("applies allowFrom fallback for WhatsApp targets", () => {
    const cfg: ClawdbotConfig = {
      agent: { heartbeat: { target: "whatsapp", to: "+1999" } },
      whatsapp: { allowFrom: ["+1555", "+1666"] },
    };
    const entry = {
      ...baseEntry,
      lastChannel: "whatsapp" as const,
      lastTo: "+1222",
    };
    expect(resolveHeartbeatDeliveryTarget({ cfg, entry })).toEqual({
      channel: "whatsapp",
      to: "+1555",
      reason: "allowFrom-fallback",
    });
  });

  it("keeps explicit telegram targets", () => {
    const cfg: ClawdbotConfig = {
      agent: { heartbeat: { target: "telegram", to: "123" } },
    };
    expect(resolveHeartbeatDeliveryTarget({ cfg, entry: baseEntry })).toEqual({
      channel: "telegram",
      to: "123",
    });
  });
});

describe("runHeartbeatOnce", () => {
  it("uses the last non-empty payload for delivery", async () => {
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
              lastChannel: "whatsapp",
              lastTo: "+1555",
            },
          },
          null,
          2,
        ),
      );

      const cfg: ClawdbotConfig = {
        agent: {
          heartbeat: { every: "5m", target: "whatsapp", to: "+1555" },
        },
        whatsapp: { allowFrom: ["*"] },
        session: { store: storePath },
      };

      replySpy.mockResolvedValue([
        { text: "Let me check..." },
        { text: "Final alert" },
      ]);
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

      expect(sendWhatsApp).toHaveBeenCalledTimes(1);
      expect(sendWhatsApp).toHaveBeenCalledWith(
        "+1555",
        "Final alert",
        expect.any(Object),
      );
    } finally {
      replySpy.mockRestore();
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

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
              lastChannel: "whatsapp",
              lastTo: "+1555",
            },
          },
          null,
          2,
        ),
      );

      const cfg: ClawdbotConfig = {
        agent: {
          heartbeat: {
            every: "5m",
            target: "whatsapp",
            to: "+1555",
            ackMaxChars: 0,
          },
        },
        whatsapp: { allowFrom: ["*"] },
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
              lastChannel: "whatsapp",
              lastTo: "+1555",
            },
          },
          null,
          2,
        ),
      );

      const cfg: ClawdbotConfig = {
        agent: {
          heartbeat: { every: "5m", target: "whatsapp", to: "+1555" },
        },
        whatsapp: { allowFrom: ["*"] },
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
});
