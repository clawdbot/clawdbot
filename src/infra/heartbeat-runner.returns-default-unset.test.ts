import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HEARTBEAT_PROMPT } from "../auto-reply/heartbeat.js";
import * as replyModule from "../auto-reply/reply.js";
import type { MoltbotConfig } from "../config/config.js";
import {
  resolveAgentIdFromSessionKey,
  resolveAgentMainSessionKey,
  resolveMainSessionKey,
  resolveStorePath,
} from "../config/sessions.js";
import { buildAgentPeerSessionKey } from "../routing/session-key.js";
import {
  isHeartbeatEnabledForAgent,
  resolveHeartbeatIntervalMs,
  resolveHeartbeatPrompt,
  runHeartbeatOnce,
} from "./heartbeat-runner.js";
import { resolveHeartbeatDeliveryTarget } from "./outbound/targets.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createPluginRuntime } from "../plugins/runtime/index.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";
import { telegramPlugin } from "../../extensions/telegram/src/channel.js";
import { whatsappPlugin } from "../../extensions/whatsapp/src/channel.js";
import { setTelegramRuntime } from "../../extensions/telegram/src/runtime.js";
import { setWhatsAppRuntime } from "../../extensions/whatsapp/src/runtime.js";

// Avoid pulling optional runtime deps during isolated runs.
vi.mock("jiti", () => ({ createJiti: () => () => ({}) }));

beforeEach(() => {
  const runtime = createPluginRuntime();
  setTelegramRuntime(runtime);
  setWhatsAppRuntime(runtime);
  setActivePluginRegistry(
    createTestRegistry([
      { pluginId: "whatsapp", plugin: whatsappPlugin, source: "test" },
      { pluginId: "telegram", plugin: telegramPlugin, source: "test" },
    ]),
  );
});

describe("resolveHeartbeatIntervalMs", () => {
  it("returns default when unset", () => {
    expect(resolveHeartbeatIntervalMs({})).toBe(30 * 60_000);
  });

  it("returns null when invalid or zero", () => {
    expect(
      resolveHeartbeatIntervalMs({
        agents: { defaults: { heartbeat: { every: "0m" } } },
      }),
    ).toBeNull();
    expect(
      resolveHeartbeatIntervalMs({
        agents: { defaults: { heartbeat: { every: "oops" } } },
      }),
    ).toBeNull();
  });

  it("parses duration strings with minute defaults", () => {
    expect(
      resolveHeartbeatIntervalMs({
        agents: { defaults: { heartbeat: { every: "5m" } } },
      }),
    ).toBe(5 * 60_000);
    expect(
      resolveHeartbeatIntervalMs({
        agents: { defaults: { heartbeat: { every: "5" } } },
      }),
    ).toBe(5 * 60_000);
    expect(
      resolveHeartbeatIntervalMs({
        agents: { defaults: { heartbeat: { every: "2h" } } },
      }),
    ).toBe(2 * 60 * 60_000);
  });

  it("uses explicit heartbeat overrides when provided", () => {
    expect(
      resolveHeartbeatIntervalMs(
        { agents: { defaults: { heartbeat: { every: "30m" } } } },
        undefined,
        { every: "5m" },
      ),
    ).toBe(5 * 60_000);
  });
});

describe("resolveHeartbeatPrompt", () => {
  it("uses the default prompt when unset", () => {
    expect(resolveHeartbeatPrompt({})).toBe(HEARTBEAT_PROMPT);
  });

  it("uses a trimmed override when configured", () => {
    const cfg: MoltbotConfig = {
      agents: { defaults: { heartbeat: { prompt: "  ping  " } } },
    };
    expect(resolveHeartbeatPrompt(cfg)).toBe("ping");
  });
});

describe("isHeartbeatEnabledForAgent", () => {
  it("enables only explicit heartbeat agents when configured", () => {
    const cfg: MoltbotConfig = {
      agents: {
        defaults: { heartbeat: { every: "30m" } },
        list: [{ id: "main" }, { id: "ops", heartbeat: { every: "1h" } }],
      },
    };
    expect(isHeartbeatEnabledForAgent(cfg, "main")).toBe(false);
    expect(isHeartbeatEnabledForAgent(cfg, "ops")).toBe(true);
  });

  it("falls back to default agent when no explicit heartbeat entries", () => {
    const cfg: MoltbotConfig = {
      agents: {
        defaults: { heartbeat: { every: "30m" } },
        list: [{ id: "main" }, { id: "ops" }],
      },
    };
    expect(isHeartbeatEnabledForAgent(cfg, "main")).toBe(true);
    expect(isHeartbeatEnabledForAgent(cfg, "ops")).toBe(false);
  });
});

describe("resolveHeartbeatDeliveryTarget", () => {
  const baseEntry = {
    sessionId: "sid",
    updatedAt: Date.now(),
  };

  it("respects target none", () => {
    const cfg: MoltbotConfig = {
      agents: { defaults: { heartbeat: { target: "none" } } },
    };
    expect(resolveHeartbeatDeliveryTarget({ cfg, entry: baseEntry })).toEqual({
      channel: "none",
      reason: "target-none",
      accountId: undefined,
      lastChannel: undefined,
      lastAccountId: undefined,
    });
  });

  it("uses last route by default", () => {
    const cfg: MoltbotConfig = {};
    const entry = {
      ...baseEntry,
      lastChannel: "whatsapp" as const,
      lastTo: "+1555",
    };
    expect(resolveHeartbeatDeliveryTarget({ cfg, entry })).toEqual({
      channel: "whatsapp",
      to: "+1555",
      accountId: undefined,
      lastChannel: "whatsapp",
      lastAccountId: undefined,
    });
  });

  it("normalizes explicit WhatsApp targets when allowFrom is '*'", () => {
    const cfg: MoltbotConfig = {
      agents: {
        defaults: {
          heartbeat: { target: "whatsapp", to: "whatsapp:(555) 123" },
        },
      },
      channels: { whatsapp: { allowFrom: ["*"] } },
    };
    expect(resolveHeartbeatDeliveryTarget({ cfg, entry: baseEntry })).toEqual({
      channel: "whatsapp",
      to: "+555123",
      accountId: undefined,
      lastChannel: undefined,
      lastAccountId: undefined,
    });
  });

  it("skips when last route is webchat", () => {
    const cfg: MoltbotConfig = {};
    const entry = {
      ...baseEntry,
      lastChannel: "webchat" as const,
      lastTo: "web",
    };
    expect(resolveHeartbeatDeliveryTarget({ cfg, entry })).toEqual({
      channel: "none",
      reason: "no-target",
      accountId: undefined,
      lastChannel: undefined,
      lastAccountId: undefined,
    });
  });

  it("applies allowFrom fallback for WhatsApp targets", () => {
    const cfg: MoltbotConfig = {
      agents: { defaults: { heartbeat: { target: "whatsapp", to: "+1999" } } },
      channels: { whatsapp: { allowFrom: ["+1555", "+1666"] } },
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
      accountId: undefined,
      lastChannel: "whatsapp",
      lastAccountId: undefined,
    });
  });

  it("keeps WhatsApp group targets even with allowFrom set", () => {
    const cfg: MoltbotConfig = {
      channels: { whatsapp: { allowFrom: ["+1555"] } },
    };
    const entry = {
      ...baseEntry,
      lastChannel: "whatsapp" as const,
      lastTo: "120363401234567890@g.us",
    };
    expect(resolveHeartbeatDeliveryTarget({ cfg, entry })).toEqual({
      channel: "whatsapp",
      to: "120363401234567890@g.us",
      accountId: undefined,
      lastChannel: "whatsapp",
      lastAccountId: undefined,
    });
  });

  it("normalizes prefixed WhatsApp group targets for heartbeat delivery", () => {
    const cfg: MoltbotConfig = {
      channels: { whatsapp: { allowFrom: ["+1555"] } },
    };
    const entry = {
      ...baseEntry,
      lastChannel: "whatsapp" as const,
      lastTo: "whatsapp:120363401234567890@G.US",
    };
    expect(resolveHeartbeatDeliveryTarget({ cfg, entry })).toEqual({
      channel: "whatsapp",
      to: "120363401234567890@g.us",
      accountId: undefined,
      lastChannel: "whatsapp",
      lastAccountId: undefined,
    });
  });

  it("keeps explicit telegram targets", () => {
    const cfg: MoltbotConfig = {
      agents: { defaults: { heartbeat: { target: "telegram", to: "123" } } },
    };
    expect(resolveHeartbeatDeliveryTarget({ cfg, entry: baseEntry })).toEqual({
      channel: "telegram",
      to: "123",
      accountId: undefined,
      lastChannel: undefined,
      lastAccountId: undefined,
    });
  });

  it("prefers per-agent heartbeat overrides when provided", () => {
    const cfg: MoltbotConfig = {
      agents: { defaults: { heartbeat: { target: "telegram", to: "123" } } },
    };
    const heartbeat = { target: "whatsapp", to: "+1555" } as const;
    expect(
      resolveHeartbeatDeliveryTarget({
        cfg,
        entry: { ...baseEntry, lastChannel: "whatsapp", lastTo: "+1999" },
        heartbeat,
      }),
    ).toEqual({
      channel: "whatsapp",
      to: "+1555",
      accountId: undefined,
      lastChannel: "whatsapp",
      lastAccountId: undefined,
    });
  });
});

describe("runHeartbeatOnce", () => {
  it("skips when agent heartbeat is not enabled", async () => {
    const cfg: MoltbotConfig = {
      agents: {
        defaults: { heartbeat: { every: "30m" } },
        list: [{ id: "main" }, { id: "ops", heartbeat: { every: "1h" } }],
      },
    };

    const res = await runHeartbeatOnce({ cfg, agentId: "main" });
    expect(res.status).toBe("skipped");
    if (res.status === "skipped") {
      expect(res.reason).toBe("disabled");
    }
  });

  it("skips outside active hours", async () => {
    const cfg: MoltbotConfig = {
      agents: {
        defaults: {
          userTimezone: "UTC",
          heartbeat: {
            every: "30m",
            activeHours: { start: "08:00", end: "24:00", timezone: "user" },
          },
        },
      },
    };

    const res = await runHeartbeatOnce({
      cfg,
      deps: { nowMs: () => Date.UTC(2025, 0, 1, 7, 0, 0) },
    });

    expect(res.status).toBe("skipped");
    if (res.status === "skipped") {
      expect(res.reason).toBe("quiet-hours");
    }
  });

  it("uses the last non-empty payload for delivery", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-hb-"));
    const storePath = path.join(tmpDir, "sessions.json");
    const replySpy = vi.spyOn(replyModule, "getReplyFromConfig");
    try {
      const cfg: MoltbotConfig = {
        agents: {
          defaults: {
            workspace: tmpDir,
            heartbeat: { every: "5m", target: "whatsapp" },
          },
        },
        channels: { whatsapp: { allowFrom: ["*"] } },
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
              lastChannel: "whatsapp",
              lastTo: "+1555",
            },
          },
          null,
          2,
        ),
      );

      replySpy.mockResolvedValue([{ text: "Let me check..." }, { text: "Final alert" }]);
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
      expect(sendWhatsApp).toHaveBeenCalledWith("+1555", "Final alert", expect.any(Object));
    } finally {
      replySpy.mockRestore();
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("uses per-agent heartbeat overrides and session keys", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-hb-"));
    const storePath = path.join(tmpDir, "sessions.json");
    const replySpy = vi.spyOn(replyModule, "getReplyFromConfig");
    try {
      const cfg: MoltbotConfig = {
        agents: {
          defaults: {
            heartbeat: { every: "30m", prompt: "Default prompt" },
          },
          list: [
            { id: "main", default: true },
            {
              id: "ops",
              heartbeat: { every: "5m", target: "whatsapp", prompt: "Ops check" },
            },
          ],
        },
        channels: { whatsapp: { allowFrom: ["*"] } },
        session: { store: storePath },
      };
      const sessionKey = resolveAgentMainSessionKey({ cfg, agentId: "ops" });

      await fs.writeFile(
        storePath,
        JSON.stringify(
          {
            [sessionKey]: {
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

      replySpy.mockResolvedValue([{ text: "Final alert" }]);
      const sendWhatsApp = vi.fn().mockResolvedValue({
        messageId: "m1",
        toJid: "jid",
      });

      await runHeartbeatOnce({
        cfg,
        agentId: "ops",
        deps: {
          sendWhatsApp,
          getQueueSize: () => 0,
          nowMs: () => 0,
          webAuthExists: async () => true,
          hasActiveWebListener: () => true,
        },
      });

      expect(sendWhatsApp).toHaveBeenCalledTimes(1);
      expect(sendWhatsApp).toHaveBeenCalledWith("+1555", "Final alert", expect.any(Object));
      expect(replySpy).toHaveBeenCalledWith(
        expect.objectContaining({ Body: "Ops check", SessionKey: sessionKey }),
        { isHeartbeat: true },
        cfg,
      );
    } finally {
      replySpy.mockRestore();
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("runs heartbeats in the explicit session key when configured", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-hb-"));
    const storePath = path.join(tmpDir, "sessions.json");
    const replySpy = vi.spyOn(replyModule, "getReplyFromConfig");
    try {
      const groupId = "120363401234567890@g.us";
      const cfg: MoltbotConfig = {
        agents: {
          defaults: {
            workspace: tmpDir,
            heartbeat: {
              every: "5m",
              target: "last",
            },
          },
        },
        channels: { whatsapp: { allowFrom: ["*"] } },
        session: { store: storePath },
      };
      const mainSessionKey = resolveMainSessionKey(cfg);
      const agentId = resolveAgentIdFromSessionKey(mainSessionKey);
      const groupSessionKey = buildAgentPeerSessionKey({
        agentId,
        channel: "whatsapp",
        peerKind: "group",
        peerId: groupId,
      });
      if (cfg.agents?.defaults?.heartbeat) {
        cfg.agents.defaults.heartbeat.session = groupSessionKey;
      }

      await fs.writeFile(
        storePath,
        JSON.stringify(
          {
            [mainSessionKey]: {
              sessionId: "sid-main",
              updatedAt: Date.now(),
              lastChannel: "whatsapp",
              lastTo: "+1555",
            },
            [groupSessionKey]: {
              sessionId: "sid-group",
              updatedAt: Date.now() + 10_000,
              lastChannel: "whatsapp",
              lastTo: groupId,
            },
          },
          null,
          2,
        ),
      );

      replySpy.mockResolvedValue([{ text: "Group alert" }]);
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
      expect(sendWhatsApp).toHaveBeenCalledWith(groupId, "Group alert", expect.any(Object));
      expect(replySpy).toHaveBeenCalledWith(
        expect.objectContaining({ SessionKey: groupSessionKey }),
        { isHeartbeat: true },
        cfg,
      );
    } finally {
      replySpy.mockRestore();
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("suppresses duplicate heartbeat payloads within 24h", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-hb-"));
    const storePath = path.join(tmpDir, "sessions.json");
    const replySpy = vi.spyOn(replyModule, "getReplyFromConfig");
    try {
      const cfg: MoltbotConfig = {
        agents: {
          defaults: {
            workspace: tmpDir,
            heartbeat: { every: "5m", target: "whatsapp" },
          },
        },
        channels: { whatsapp: { allowFrom: ["*"] } },
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
              lastChannel: "whatsapp",
              lastTo: "+1555",
              lastHeartbeatText: "Final alert",
              lastHeartbeatSentAt: 0,
            },
          },
          null,
          2,
        ),
      );

      replySpy.mockResolvedValue([{ text: "Final alert" }]);
      const sendWhatsApp = vi.fn().mockResolvedValue({ messageId: "m1", toJid: "jid" });

      await runHeartbeatOnce({
        cfg,
        deps: {
          sendWhatsApp,
          getQueueSize: () => 0,
          nowMs: () => 60_000,
          webAuthExists: async () => true,
          hasActiveWebListener: () => true,
        },
      });

      expect(sendWhatsApp).toHaveBeenCalledTimes(0);
    } finally {
      replySpy.mockRestore();
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("can include reasoning payloads when enabled", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-hb-"));
    const storePath = path.join(tmpDir, "sessions.json");
    const replySpy = vi.spyOn(replyModule, "getReplyFromConfig");
    try {
      const cfg: MoltbotConfig = {
        agents: {
          defaults: {
            workspace: tmpDir,
            heartbeat: {
              every: "5m",
              target: "whatsapp",
              includeReasoning: true,
            },
          },
        },
        channels: { whatsapp: { allowFrom: ["*"] } },
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
              lastChannel: "whatsapp",
              lastProvider: "whatsapp",
              lastTo: "+1555",
            },
          },
          null,
          2,
        ),
      );

      replySpy.mockResolvedValue([
        { text: "Reasoning:\n_Because it helps_" },
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

      expect(sendWhatsApp).toHaveBeenCalledTimes(2);
      expect(sendWhatsApp).toHaveBeenNthCalledWith(
        1,
        "+1555",
        "Reasoning:\n_Because it helps_",
        expect.any(Object),
      );
      expect(sendWhatsApp).toHaveBeenNthCalledWith(2, "+1555", "Final alert", expect.any(Object));
    } finally {
      replySpy.mockRestore();
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("delivers reasoning even when the main heartbeat reply is HEARTBEAT_OK", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-hb-"));
    const storePath = path.join(tmpDir, "sessions.json");
    const replySpy = vi.spyOn(replyModule, "getReplyFromConfig");
    try {
      const cfg: MoltbotConfig = {
        agents: {
          defaults: {
            workspace: tmpDir,
            heartbeat: {
              every: "5m",
              target: "whatsapp",
              includeReasoning: true,
            },
          },
        },
        channels: { whatsapp: { allowFrom: ["*"] } },
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
              lastChannel: "whatsapp",
              lastProvider: "whatsapp",
              lastTo: "+1555",
            },
          },
          null,
          2,
        ),
      );

      replySpy.mockResolvedValue([
        { text: "Reasoning:\n_Because it helps_" },
        { text: "HEARTBEAT_OK" },
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
      expect(sendWhatsApp).toHaveBeenNthCalledWith(
        1,
        "+1555",
        "Reasoning:\n_Because it helps_",
        expect.any(Object),
      );
    } finally {
      replySpy.mockRestore();
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("loads the default agent session from templated stores", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-hb-"));
    const storeTemplate = path.join(tmpDir, "agents", "{agentId}", "sessions.json");
    const replySpy = vi.spyOn(replyModule, "getReplyFromConfig");
    try {
      const cfg: MoltbotConfig = {
        agents: {
          defaults: { workspace: tmpDir, heartbeat: { every: "5m" } },
          list: [{ id: "work", default: true }],
        },
        channels: { whatsapp: { allowFrom: ["*"] } },
        session: { store: storeTemplate },
      };
      const sessionKey = resolveMainSessionKey(cfg);
      const agentId = resolveAgentIdFromSessionKey(sessionKey);
      const storePath = resolveStorePath(storeTemplate, { agentId });

      await fs.mkdir(path.dirname(storePath), { recursive: true });
      await fs.writeFile(
        storePath,
        JSON.stringify(
          {
            [sessionKey]: {
              sessionId: "sid",
              updatedAt: Date.now(),
              lastChannel: "whatsapp",
              lastProvider: "whatsapp",
              lastTo: "+1555",
            },
          },
          null,
          2,
        ),
      );

      replySpy.mockResolvedValue({ text: "Hello from heartbeat" });
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
        "Hello from heartbeat",
        expect.any(Object),
      );
    } finally {
      replySpy.mockRestore();
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("skips heartbeat when HEARTBEAT.md is effectively empty (saves API calls)", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-hb-"));
    const storePath = path.join(tmpDir, "sessions.json");
    const workspaceDir = path.join(tmpDir, "workspace");
    const replySpy = vi.spyOn(replyModule, "getReplyFromConfig");
    try {
      await fs.mkdir(workspaceDir, { recursive: true });

      // Create effectively empty HEARTBEAT.md (only header and comments)
      await fs.writeFile(
        path.join(workspaceDir, "HEARTBEAT.md"),
        "# HEARTBEAT.md\n\n## Tasks\n\n",
        "utf-8",
      );

      const cfg: MoltbotConfig = {
        agents: {
          defaults: {
            workspace: workspaceDir,
            heartbeat: { every: "5m", target: "whatsapp" },
          },
        },
        channels: { whatsapp: { allowFrom: ["*"] } },
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
              lastChannel: "whatsapp",
              lastTo: "+1555",
            },
          },
          null,
          2,
        ),
      );

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
          webAuthExists: async () => true,
          hasActiveWebListener: () => true,
        },
      });

      // Should skip without making API call
      expect(res.status).toBe("skipped");
      if (res.status === "skipped") {
        expect(res.reason).toBe("empty-heartbeat-file");
      }
      expect(replySpy).not.toHaveBeenCalled();
      expect(sendWhatsApp).not.toHaveBeenCalled();
    } finally {
      replySpy.mockRestore();
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("runs heartbeat when HEARTBEAT.md has actionable content", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-hb-"));
    const storePath = path.join(tmpDir, "sessions.json");
    const workspaceDir = path.join(tmpDir, "workspace");
    const replySpy = vi.spyOn(replyModule, "getReplyFromConfig");
    try {
      await fs.mkdir(workspaceDir, { recursive: true });

      // Create HEARTBEAT.md with actionable content
      await fs.writeFile(
        path.join(workspaceDir, "HEARTBEAT.md"),
        "# HEARTBEAT.md\n\n- Check server logs\n- Review pending PRs\n",
        "utf-8",
      );

      const cfg: MoltbotConfig = {
        agents: {
          defaults: {
            workspace: workspaceDir,
            heartbeat: { every: "5m", target: "whatsapp" },
          },
        },
        channels: { whatsapp: { allowFrom: ["*"] } },
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
              lastChannel: "whatsapp",
              lastTo: "+1555",
            },
          },
          null,
          2,
        ),
      );

      replySpy.mockResolvedValue({ text: "Checked logs and PRs" });
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
          webAuthExists: async () => true,
          hasActiveWebListener: () => true,
        },
      });

      // Should run and make API call
      expect(res.status).toBe("ran");
      expect(replySpy).toHaveBeenCalled();
      expect(sendWhatsApp).toHaveBeenCalledTimes(1);
    } finally {
      replySpy.mockRestore();
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("runs heartbeat when HEARTBEAT.md does not exist (lets LLM decide)", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-hb-"));
    const storePath = path.join(tmpDir, "sessions.json");
    const workspaceDir = path.join(tmpDir, "workspace");
    const replySpy = vi.spyOn(replyModule, "getReplyFromConfig");
    try {
      await fs.mkdir(workspaceDir, { recursive: true });
      // Don't create HEARTBEAT.md - it doesn't exist

      const cfg: MoltbotConfig = {
        agents: {
          defaults: {
            workspace: workspaceDir,
            heartbeat: { every: "5m", target: "whatsapp" },
          },
        },
        channels: { whatsapp: { allowFrom: ["*"] } },
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
              lastChannel: "whatsapp",
              lastTo: "+1555",
            },
          },
          null,
          2,
        ),
      );

      replySpy.mockResolvedValue({ text: "HEARTBEAT_OK" });
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
          webAuthExists: async () => true,
          hasActiveWebListener: () => true,
        },
      });

      // Should run (not skip) - let LLM decide since file doesn't exist
      expect(res.status).toBe("ran");
      expect(replySpy).toHaveBeenCalled();
    } finally {
      replySpy.mockRestore();
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
