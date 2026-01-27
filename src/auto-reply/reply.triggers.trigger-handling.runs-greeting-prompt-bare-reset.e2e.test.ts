import { tmpdir } from "node:os";
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

function _makeCfg(home: string) {
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
  it("runs a greeting prompt for a bare /reset", async () => {
    await withTempHome(async (home) => {
      vi.mocked(runEmbeddedPiAgent).mockResolvedValue({
        payloads: [{ text: "hello" }],
        meta: {
          durationMs: 1,
          agentMeta: { sessionId: "s", provider: "p", model: "m" },
        },
      });

      const res = await getReplyFromConfig(
        {
          Body: "/reset",
          From: "+1003",
          To: "+2000",
          CommandAuthorized: true,
        },
        {},
        {
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
          session: {
            store: join(tmpdir(), `moltbot-session-test-${Date.now()}.json`),
          },
        },
      );
      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(text).toBe("hello");
      expect(runEmbeddedPiAgent).toHaveBeenCalledOnce();
      const prompt = vi.mocked(runEmbeddedPiAgent).mock.calls[0]?.[0]?.prompt ?? "";
      expect(prompt).toContain("A new session was started via /new or /reset");
    });
  });
  it("does not reset for unauthorized /reset", async () => {
    await withTempHome(async (home) => {
      const res = await getReplyFromConfig(
        {
          Body: "/reset",
          From: "+1003",
          To: "+2000",
          CommandAuthorized: false,
        },
        {},
        {
          agents: {
            defaults: {
              model: "anthropic/claude-opus-4-5",
              workspace: join(home, "clawd"),
            },
          },
          channels: {
            whatsapp: {
              allowFrom: ["+1999"],
            },
          },
          session: {
            store: join(tmpdir(), `moltbot-session-test-${Date.now()}.json`),
          },
        },
      );
      expect(res).toBeUndefined();
      expect(runEmbeddedPiAgent).not.toHaveBeenCalled();
    });
  });
  it("blocks /reset for non-owner senders", async () => {
    await withTempHome(async (home) => {
      const res = await getReplyFromConfig(
        {
          Body: "/reset",
          From: "+1003",
          To: "+2000",
          CommandAuthorized: true,
        },
        {},
        {
          agents: {
            defaults: {
              model: "anthropic/claude-opus-4-5",
              workspace: join(home, "clawd"),
            },
          },
          channels: {
            whatsapp: {
              allowFrom: ["+1999"],
            },
          },
          session: {
            store: join(tmpdir(), `moltbot-session-test-${Date.now()}.json`),
          },
        },
      );
      expect(res).toBeUndefined();
      expect(runEmbeddedPiAgent).not.toHaveBeenCalled();
    });
  });
});
