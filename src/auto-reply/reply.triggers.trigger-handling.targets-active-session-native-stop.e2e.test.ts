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
import { loadSessionStore } from "../config/sessions.js";
import { enqueueFollowupRun, getFollowupQueueDepth, type FollowupRun } from "./reply/queue.js";
import { getReplyFromConfig } from "./reply.js";

const MAIN_SESSION_KEY = "agent:main:main";

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
  it("targets the active session for native /stop", async () => {
    await withTempHome(async (home) => {
      const cfg = makeCfg(home);
      const targetSessionKey = "agent:main:telegram:group:123";
      const targetSessionId = "session-target";
      await fs.writeFile(
        cfg.session.store,
        JSON.stringify(
          {
            [targetSessionKey]: {
              sessionId: targetSessionId,
              updatedAt: Date.now(),
            },
          },
          null,
          2,
        ),
      );
      const followupRun: FollowupRun = {
        prompt: "queued",
        enqueuedAt: Date.now(),
        run: {
          agentId: "main",
          agentDir: join(home, "agent"),
          sessionId: targetSessionId,
          sessionKey: targetSessionKey,
          messageProvider: "telegram",
          agentAccountId: "acct",
          sessionFile: join(home, "session.jsonl"),
          workspaceDir: join(home, "workspace"),
          config: cfg,
          provider: "anthropic",
          model: "claude-opus-4-5",
          timeoutMs: 1000,
          blockReplyBreak: "text_end",
        },
      };
      enqueueFollowupRun(
        targetSessionKey,
        followupRun,
        { mode: "collect", debounceMs: 0, cap: 20, dropPolicy: "summarize" },
        "none",
      );
      expect(getFollowupQueueDepth(targetSessionKey)).toBe(1);

      const res = await getReplyFromConfig(
        {
          Body: "/stop",
          From: "telegram:111",
          To: "telegram:111",
          ChatType: "direct",
          Provider: "telegram",
          Surface: "telegram",
          SessionKey: "telegram:slash:111",
          CommandSource: "native",
          CommandTargetSessionKey: targetSessionKey,
          CommandAuthorized: true,
        },
        {},
        cfg,
      );

      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(text).toBe("⚙️ Agent was aborted.");
      expect(vi.mocked(abortEmbeddedPiRun)).toHaveBeenCalledWith(targetSessionId);
      const store = loadSessionStore(cfg.session.store);
      expect(store[targetSessionKey]?.abortedLastRun).toBe(true);
      expect(getFollowupQueueDepth(targetSessionKey)).toBe(0);
    });
  });
  it("applies native /model to the target session", async () => {
    await withTempHome(async (home) => {
      const cfg = makeCfg(home);
      const slashSessionKey = "telegram:slash:111";
      const targetSessionKey = MAIN_SESSION_KEY;

      // Seed the target session to ensure the native command mutates it.
      await fs.writeFile(
        cfg.session.store,
        JSON.stringify(
          {
            [targetSessionKey]: {
              sessionId: "session-target",
              updatedAt: Date.now(),
            },
          },
          null,
          2,
        ),
      );

      const res = await getReplyFromConfig(
        {
          Body: "/model openai/gpt-4.1-mini",
          From: "telegram:111",
          To: "telegram:111",
          ChatType: "direct",
          Provider: "telegram",
          Surface: "telegram",
          SessionKey: slashSessionKey,
          CommandSource: "native",
          CommandTargetSessionKey: targetSessionKey,
          CommandAuthorized: true,
        },
        {},
        cfg,
      );

      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(text).toContain("Model set to openai/gpt-4.1-mini");

      const store = loadSessionStore(cfg.session.store);
      expect(store[targetSessionKey]?.providerOverride).toBe("openai");
      expect(store[targetSessionKey]?.modelOverride).toBe("gpt-4.1-mini");
      expect(store[slashSessionKey]).toBeUndefined();

      vi.mocked(runEmbeddedPiAgent).mockResolvedValue({
        payloads: [{ text: "ok" }],
        meta: {
          durationMs: 5,
          agentMeta: { sessionId: "s", provider: "p", model: "m" },
        },
      });

      await getReplyFromConfig(
        {
          Body: "hi",
          From: "telegram:111",
          To: "telegram:111",
          ChatType: "direct",
          Provider: "telegram",
          Surface: "telegram",
        },
        {},
        cfg,
      );

      expect(runEmbeddedPiAgent).toHaveBeenCalledOnce();
      expect(vi.mocked(runEmbeddedPiAgent).mock.calls[0]?.[0]).toEqual(
        expect.objectContaining({
          provider: "openai",
          model: "gpt-4.1-mini",
        }),
      );
    });
  });

  it("uses the target agent model for native /status", async () => {
    await withTempHome(async (home) => {
      const cfg = {
        agents: {
          defaults: {
            model: "anthropic/claude-opus-4-5",
            workspace: join(home, "clawd"),
          },
          list: [{ id: "coding", model: "minimax/MiniMax-M2.1" }],
        },
        channels: {
          telegram: {
            allowFrom: ["*"],
          },
        },
        session: { store: join(home, "sessions.json") },
      };

      const res = await getReplyFromConfig(
        {
          Body: "/status",
          From: "telegram:111",
          To: "telegram:111",
          ChatType: "group",
          Provider: "telegram",
          Surface: "telegram",
          SessionKey: "telegram:slash:111",
          CommandSource: "native",
          CommandTargetSessionKey: "agent:coding:telegram:group:123",
          CommandAuthorized: true,
        },
        {},
        cfg,
      );

      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(text).toContain("minimax/MiniMax-M2.1");
    });
  });
});
