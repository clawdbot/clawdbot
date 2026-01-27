import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeTestText } from "../../test/helpers/normalize-text.js";
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
  formatUsageWindowSummary: vi.fn().mockReturnValue("Claude 80% left"),
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

async function readSessionStore(home: string): Promise<Record<string, unknown>> {
  const raw = await readFile(join(home, "sessions.json"), "utf-8");
  return JSON.parse(raw) as Record<string, unknown>;
}

function pickFirstStoreEntry<T>(store: Record<string, unknown>): T | undefined {
  const entries = Object.values(store) as T[];
  return entries[0];
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("trigger handling", () => {
  it("filters usage summary to the current model provider", async () => {
    await withTempHome(async (home) => {
      usageMocks.loadProviderUsageSummary.mockClear();
      usageMocks.loadProviderUsageSummary.mockResolvedValue({
        updatedAt: 0,
        providers: [
          {
            provider: "anthropic",
            displayName: "Anthropic",
            windows: [
              {
                label: "5h",
                usedPercent: 20,
              },
            ],
          },
        ],
      });

      const res = await getReplyFromConfig(
        {
          Body: "/status",
          From: "+1000",
          To: "+2000",
          Provider: "whatsapp",
          SenderE164: "+1000",
          CommandAuthorized: true,
        },
        {},
        makeCfg(home),
      );

      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(normalizeTestText(text ?? "")).toContain("Usage: Claude 80% left");
      expect(usageMocks.loadProviderUsageSummary).toHaveBeenCalledWith(
        expect.objectContaining({ providers: ["anthropic"] }),
      );
    });
  });
  it("emits /status once (no duplicate inline + final)", async () => {
    await withTempHome(async (home) => {
      const blockReplies: Array<{ text?: string }> = [];
      const res = await getReplyFromConfig(
        {
          Body: "/status",
          From: "+1000",
          To: "+2000",
          Provider: "whatsapp",
          SenderE164: "+1000",
          CommandAuthorized: true,
        },
        {
          onBlockReply: async (payload) => {
            blockReplies.push(payload);
          },
        },
        makeCfg(home),
      );
      const replies = res ? (Array.isArray(res) ? res : [res]) : [];
      expect(blockReplies.length).toBe(0);
      expect(replies.length).toBe(1);
      expect(String(replies[0]?.text ?? "")).toContain("Model:");
    });
  });
  it("sets per-response usage footer via /usage", async () => {
    await withTempHome(async (home) => {
      const blockReplies: Array<{ text?: string }> = [];
      const res = await getReplyFromConfig(
        {
          Body: "/usage tokens",
          From: "+1000",
          To: "+2000",
          Provider: "whatsapp",
          SenderE164: "+1000",
          CommandAuthorized: true,
        },
        {
          onBlockReply: async (payload) => {
            blockReplies.push(payload);
          },
        },
        makeCfg(home),
      );
      const replies = res ? (Array.isArray(res) ? res : [res]) : [];
      expect(blockReplies.length).toBe(0);
      expect(replies.length).toBe(1);
      expect(String(replies[0]?.text ?? "")).toContain("Usage footer: tokens");
      expect(runEmbeddedPiAgent).not.toHaveBeenCalled();
    });
  });

  it("cycles /usage modes and persists to the session store", async () => {
    await withTempHome(async (home) => {
      const cfg = makeCfg(home);

      const r1 = await getReplyFromConfig(
        {
          Body: "/usage",
          From: "+1000",
          To: "+2000",
          Provider: "whatsapp",
          SenderE164: "+1000",
          CommandAuthorized: true,
        },
        undefined,
        cfg,
      );
      expect(String((Array.isArray(r1) ? r1[0]?.text : r1?.text) ?? "")).toContain(
        "Usage footer: tokens",
      );
      const s1 = await readSessionStore(home);
      expect(pickFirstStoreEntry<{ responseUsage?: string }>(s1)?.responseUsage).toBe("tokens");

      const r2 = await getReplyFromConfig(
        {
          Body: "/usage",
          From: "+1000",
          To: "+2000",
          Provider: "whatsapp",
          SenderE164: "+1000",
          CommandAuthorized: true,
        },
        undefined,
        cfg,
      );
      expect(String((Array.isArray(r2) ? r2[0]?.text : r2?.text) ?? "")).toContain(
        "Usage footer: full",
      );
      const s2 = await readSessionStore(home);
      expect(pickFirstStoreEntry<{ responseUsage?: string }>(s2)?.responseUsage).toBe("full");

      const r3 = await getReplyFromConfig(
        {
          Body: "/usage",
          From: "+1000",
          To: "+2000",
          Provider: "whatsapp",
          SenderE164: "+1000",
          CommandAuthorized: true,
        },
        undefined,
        cfg,
      );
      expect(String((Array.isArray(r3) ? r3[0]?.text : r3?.text) ?? "")).toContain(
        "Usage footer: off",
      );
      const s3 = await readSessionStore(home);
      expect(pickFirstStoreEntry<{ responseUsage?: string }>(s3)?.responseUsage).toBeUndefined();

      expect(runEmbeddedPiAgent).not.toHaveBeenCalled();
    });
  });

  it("treats /usage on as tokens (back-compat)", async () => {
    await withTempHome(async (home) => {
      const cfg = makeCfg(home);
      const res = await getReplyFromConfig(
        {
          Body: "/usage on",
          From: "+1000",
          To: "+2000",
          Provider: "whatsapp",
          SenderE164: "+1000",
          CommandAuthorized: true,
        },
        undefined,
        cfg,
      );
      const replies = res ? (Array.isArray(res) ? res : [res]) : [];
      expect(replies.length).toBe(1);
      expect(String(replies[0]?.text ?? "")).toContain("Usage footer: tokens");

      const store = await readSessionStore(home);
      expect(pickFirstStoreEntry<{ responseUsage?: string }>(store)?.responseUsage).toBe("tokens");

      expect(runEmbeddedPiAgent).not.toHaveBeenCalled();
    });
  });
  it("sends one inline status and still returns agent reply for mixed text", async () => {
    await withTempHome(async (home) => {
      vi.mocked(runEmbeddedPiAgent).mockResolvedValue({
        payloads: [{ text: "agent says hi" }],
        meta: {
          durationMs: 1,
          agentMeta: { sessionId: "s", provider: "p", model: "m" },
        },
      });
      const blockReplies: Array<{ text?: string }> = [];
      const res = await getReplyFromConfig(
        {
          Body: "here we go /status now",
          From: "+1002",
          To: "+2000",
          Provider: "whatsapp",
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
      const replies = res ? (Array.isArray(res) ? res : [res]) : [];
      expect(blockReplies.length).toBe(1);
      expect(String(blockReplies[0]?.text ?? "")).toContain("Model:");
      expect(replies.length).toBe(1);
      expect(replies[0]?.text).toBe("agent says hi");
      const prompt = vi.mocked(runEmbeddedPiAgent).mock.calls[0]?.[0]?.prompt ?? "";
      expect(prompt).not.toContain("/status");
    });
  });
  it("aborts even with timestamp prefix", async () => {
    await withTempHome(async (home) => {
      const res = await getReplyFromConfig(
        {
          Body: "[Dec 5 10:00] stop",
          From: "+1000",
          To: "+2000",
          CommandAuthorized: true,
        },
        {},
        makeCfg(home),
      );
      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(text).toBe("⚙️ Agent was aborted.");
      expect(runEmbeddedPiAgent).not.toHaveBeenCalled();
    });
  });
  it("handles /stop without invoking the agent", async () => {
    await withTempHome(async (home) => {
      const res = await getReplyFromConfig(
        {
          Body: "/stop",
          From: "+1003",
          To: "+2000",
          CommandAuthorized: true,
        },
        {},
        makeCfg(home),
      );
      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(text).toBe("⚙️ Agent was aborted.");
      expect(runEmbeddedPiAgent).not.toHaveBeenCalled();
    });
  });
});
