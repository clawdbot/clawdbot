import fs from "node:fs/promises";
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
import { resolveSessionKey } from "../config/sessions.js";
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
  it("reports active auth profile and key snippet in status", async () => {
    await withTempHome(async (home) => {
      const cfg = makeCfg(home);
      const agentDir = join(home, ".clawdbot", "agents", "main", "agent");
      await fs.mkdir(agentDir, { recursive: true });
      await fs.writeFile(
        join(agentDir, "auth-profiles.json"),
        JSON.stringify(
          {
            version: 1,
            profiles: {
              "anthropic:work": {
                type: "api_key",
                provider: "anthropic",
                key: "sk-test-1234567890abcdef",
              },
            },
            lastGood: { anthropic: "anthropic:work" },
          },
          null,
          2,
        ),
      );

      const sessionKey = resolveSessionKey("per-sender", {
        From: "+1002",
        To: "+2000",
        Provider: "whatsapp",
      } as Parameters<typeof resolveSessionKey>[1]);
      await fs.writeFile(
        cfg.session.store,
        JSON.stringify(
          {
            [sessionKey]: {
              sessionId: "session-auth",
              updatedAt: Date.now(),
              authProfileOverride: "anthropic:work",
            },
          },
          null,
          2,
        ),
      );

      const res = await getReplyFromConfig(
        {
          Body: "/status",
          From: "+1002",
          To: "+2000",
          Provider: "whatsapp",
          SenderE164: "+1002",
          CommandAuthorized: true,
        },
        {},
        cfg,
      );
      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(text).toContain("api-key");
      expect(text).toMatch(/…|\.{3}/);
      expect(text).toContain("(anthropic:work)");
      expect(text).not.toContain("mixed");
      expect(runEmbeddedPiAgent).not.toHaveBeenCalled();
    });
  });
  it("strips inline /status and still runs the agent", async () => {
    await withTempHome(async (home) => {
      vi.mocked(runEmbeddedPiAgent).mockResolvedValue({
        payloads: [{ text: "ok" }],
        meta: {
          durationMs: 1,
          agentMeta: { sessionId: "s", provider: "p", model: "m" },
        },
      });
      const blockReplies: Array<{ text?: string }> = [];
      await getReplyFromConfig(
        {
          Body: "please /status now",
          From: "+1002",
          To: "+2000",
          Provider: "whatsapp",
          Surface: "whatsapp",
          SenderE164: "+1002",
          CommandAuthorized: true,
        },
        {
          onBlockReply: async (payload) => {
            blockReplies.push(payload);
          },
        },
        makeCfg(home),
      );
      expect(runEmbeddedPiAgent).toHaveBeenCalled();
      // Allowlisted senders: inline /status runs immediately (like /help) and is
      // stripped from the prompt; the remaining text continues through the agent.
      expect(blockReplies.length).toBe(1);
      expect(String(blockReplies[0]?.text ?? "").length).toBeGreaterThan(0);
      const prompt = vi.mocked(runEmbeddedPiAgent).mock.calls[0]?.[0]?.prompt ?? "";
      expect(prompt).not.toContain("/status");
    });
  });
  it("handles inline /help and strips it before the agent", async () => {
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
          Body: "please /help now",
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
      expect(blockReplies[0]?.text).toContain("Help");
      expect(runEmbeddedPiAgent).toHaveBeenCalled();
      const prompt = vi.mocked(runEmbeddedPiAgent).mock.calls[0]?.[0]?.prompt ?? "";
      expect(prompt).not.toContain("/help");
      expect(text).toBe("ok");
    });
  });
});
