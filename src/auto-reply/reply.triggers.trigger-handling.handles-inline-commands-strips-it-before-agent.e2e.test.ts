import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withTempHome as withTempHomeBase } from "../../test/helpers/temp-home.js";

vi.mock("../agents/pi-embedded.js", () => ({
  abortEmbeddedPiRun: vi.fn().mockReturnValue(false),
  compactEmbeddedPiSession: vi.fn(),
  runEmbeddedPiAgent: vi.fn(),
  queueEmbeddedPiMessage: vi.fn().mockReturnValue(false),
  resolveEmbeddedSessionLane: (key: string) => `session:${key.trim() || "main"}`,
  isEmbeddedPiRunActive: vi.fn().mockReturnValue(false),
  isEmbeddedPiRunStreaming: vi.fn().mockReturnValue(false),
}));

const usageMocks = vi.hoisted(() => ({
  loadProviderUsageSummary: vi.fn().mockResolvedValue({
    updatedAt: 0,
    providers: [],
  }),
  formatUsageSummaryLine: vi.fn().mockReturnValue("📊 Usage: Claude 80% left"),
  resolveUsageProviderId: vi.fn((provider: string) => provider.split("/")[0]),
}));

vi.mock("../infra/provider-usage.js", () => usageMocks);

const modelCatalogMocks = vi.hoisted(() => ({
  loadModelCatalog: vi.fn().mockResolvedValue([
    {
      provider: "anthropic",
      id: "claude-opus-4-5",
      name: "Claude Opus 4.5",
      contextWindow: 200000,
    },
    {
      provider: "openrouter",
      id: "anthropic/claude-opus-4-5",
      name: "Claude Opus 4.5 (OpenRouter)",
      contextWindow: 200000,
    },
    { provider: "openai", id: "gpt-4.1-mini", name: "GPT-4.1 mini" },
    { provider: "openai", id: "gpt-5.2", name: "GPT-5.2" },
    { provider: "openai-codex", id: "gpt-5.2", name: "GPT-5.2 (Codex)" },
    { provider: "minimax", id: "MiniMax-M2.1", name: "MiniMax M2.1" },
  ]),
  resetModelCatalogCacheForTest: vi.fn(),
}));

vi.mock("../agents/model-catalog.js", () => modelCatalogMocks);

import { abortEmbeddedPiRun, runEmbeddedPiAgent } from "../agents/pi-embedded.js";
import { getReplyFromConfig } from "./reply.js";

const _MAIN_SESSION_KEY = "agent:main:main";

const webMocks = vi.hoisted(() => ({
  webAuthExists: vi.fn().mockResolvedValue(true),
  getWebAuthAgeMs: vi.fn().mockReturnValue(120_000),
  readWebSelfId: vi.fn().mockReturnValue({ e164: "+1999" }),
}));

vi.mock("../web/session.js", () => webMocks);

async function withTempHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  return withTempHomeBase(
    async (home) => {
      vi.mocked(runEmbeddedPiAgent).mockClear();
      vi.mocked(abortEmbeddedPiRun).mockClear();
      return await fn(home);
    },
    { prefix: "moltbot-triggers-" },
  );
}

function makeCfg(home: string) {
  return {
    agents: {
      defaults: {
        model: "anthropic/claude-opus-4-5",
        workspace: join(home, "clawd"),
      },
    },
    channels: {
      whatsapp: {
        allowFrom: ["*"],
      },
    },
    session: { store: join(home, "sessions.json") },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("trigger handling", () => {
  it("handles inline /commands and strips it before the agent", async () => {
    await withTempHome(async (home) => {
      vi.mocked(runEmbeddedPiAgent).mockResolvedValue({
        payloads: [{ text: "ok" }],
        meta: {
          durationMs: 1,
          agentMeta: { sessionId: "s", provider: "p", model: "m" },
        },
      });
      const blockReplies: Array<{ text?: string }> = [];
      const res = await getReplyFromConfig(
        {
          Body: "please /commands now",
          From: "+1002",
          To: "+2000",
          CommandAuthorized: true,
        },
        {
          onBlockReply: async (payload) => {
            blockReplies.push(payload);
          },
        },
        makeCfg(home),
      );
      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(blockReplies.length).toBe(1);
      expect(blockReplies[0]?.text).toContain("Slash commands");
      expect(runEmbeddedPiAgent).toHaveBeenCalled();
      const prompt = vi.mocked(runEmbeddedPiAgent).mock.calls[0]?.[0]?.prompt ?? "";
      expect(prompt).not.toContain("/commands");
      expect(text).toBe("ok");
    });
  });
  it("handles inline /whoami and strips it before the agent", async () => {
    await withTempHome(async (home) => {
      vi.mocked(runEmbeddedPiAgent).mockResolvedValue({
        payloads: [{ text: "ok" }],
        meta: {
          durationMs: 1,
          agentMeta: { sessionId: "s", provider: "p", model: "m" },
        },
      });
      const blockReplies: Array<{ text?: string }> = [];
      const res = await getReplyFromConfig(
        {
          Body: "please /whoami now",
          From: "+1002",
          To: "+2000",
          SenderId: "12345",
          CommandAuthorized: true,
        },
        {
          onBlockReply: async (payload) => {
            blockReplies.push(payload);
          },
        },
        makeCfg(home),
      );
      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(blockReplies.length).toBe(1);
      expect(blockReplies[0]?.text).toContain("Identity");
      expect(runEmbeddedPiAgent).toHaveBeenCalled();
      const prompt = vi.mocked(runEmbeddedPiAgent).mock.calls[0]?.[0]?.prompt ?? "";
      expect(prompt).not.toContain("/whoami");
      expect(text).toBe("ok");
    });
  });
  it("drops /status for unauthorized senders", async () => {
    await withTempHome(async (home) => {
      const cfg = {
        agents: {
          defaults: {
            model: "anthropic/claude-opus-4-5",
            workspace: join(home, "clawd"),
          },
        },
        channels: {
          whatsapp: {
            allowFrom: ["+1000"],
          },
        },
        session: { store: join(home, "sessions.json") },
      };
      const res = await getReplyFromConfig(
        {
          Body: "/status",
          From: "+2001",
          To: "+2000",
          Provider: "whatsapp",
          SenderE164: "+2001",
        },
        {},
        cfg,
      );
      expect(res).toBeUndefined();
      expect(runEmbeddedPiAgent).not.toHaveBeenCalled();
    });
  });
  it("drops /whoami for unauthorized senders", async () => {
    await withTempHome(async (home) => {
      const cfg = {
        agents: {
          defaults: {
            model: "anthropic/claude-opus-4-5",
            workspace: join(home, "clawd"),
          },
        },
        channels: {
          whatsapp: {
            allowFrom: ["+1000"],
          },
        },
        session: { store: join(home, "sessions.json") },
      };
      const res = await getReplyFromConfig(
        {
          Body: "/whoami",
          From: "+2001",
          To: "+2000",
          Provider: "whatsapp",
          SenderE164: "+2001",
        },
        {},
        cfg,
      );
      expect(res).toBeUndefined();
      expect(runEmbeddedPiAgent).not.toHaveBeenCalled();
    });
  });
});
