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
  formatUsageSummaryLine: vi.fn().mockReturnValue("Usage: Claude 80% left"),
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
  ]),
  resetModelCatalogCacheForTest: vi.fn(),
}));
vi.mock("../agents/model-catalog.js", () => modelCatalogMocks);

const webMocks = vi.hoisted(() => ({
  webAuthExists: vi.fn().mockResolvedValue(true),
  getWebAuthAgeMs: vi.fn().mockReturnValue(120_000),
  readWebSelfId: vi.fn().mockReturnValue({ e164: "+1999" }),
}));
vi.mock("../web/session.js", () => webMocks);

import { abortEmbeddedPiRun, runEmbeddedPiAgent } from "../agents/pi-embedded.js";
import { getReplyFromConfig } from "../auto-reply/reply.js";
import { resolveAgentRoute } from "../routing/resolve-route.js";
import type { MoltbotConfig } from "../config/config.js";

async function withTempHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  return withTempHomeBase(
    async (home) => {
      vi.mocked(runEmbeddedPiAgent).mockClear();
      vi.mocked(abortEmbeddedPiRun).mockClear();
      return await fn(home);
    },
    { prefix: "moltbot-pipeline-e2e-" },
  );
}

function makeCfg(home: string, overrides?: Partial<MoltbotConfig>): MoltbotConfig {
  return {
    agents: {
      defaults: {
        model: "anthropic/claude-opus-4-5",
        workspace: join(home, "clawd"),
      },
    },
    channels: {
      whatsapp: { allowFrom: ["*"] },
    },
    session: { store: join(home, "sessions.json") },
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("full pipeline: inbound -> routing -> agent -> reply", () => {
  it("routes a WhatsApp DM through the agent and returns a reply", async () => {
    await withTempHome(async (home) => {
      vi.mocked(runEmbeddedPiAgent).mockResolvedValue({
        payloads: [{ text: "Hello from the agent!" }],
        meta: {
          durationMs: 100,
          agentMeta: { sessionId: "s1", provider: "anthropic", model: "claude-opus-4-5" },
        },
      });

      const cfg = makeCfg(home);

      // Verify routing resolves to default agent
      const route = resolveAgentRoute({
        cfg,
        channel: "whatsapp",
        accountId: null,
        peer: { kind: "dm", id: "+15551234567" },
      });
      expect(route.agentId).toBe("main");
      expect(route.matchedBy).toBe("default");

      // Run the full reply pipeline
      const res = await getReplyFromConfig(
        {
          Body: "hello",
          From: "+15551234567",
          To: "+1999",
          Provider: "whatsapp",
          ChatType: "direct",
        },
        {},
        cfg,
      );

      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(text).toBe("Hello from the agent!");
      expect(runEmbeddedPiAgent).toHaveBeenCalledOnce();
    });
  });

  it("routes to a specific agent via peer binding", async () => {
    await withTempHome(async (home) => {
      vi.mocked(runEmbeddedPiAgent).mockResolvedValue({
        payloads: [{ text: "Hi from custom agent" }],
        meta: {
          durationMs: 50,
          agentMeta: { sessionId: "s2", provider: "anthropic", model: "claude-opus-4-5" },
        },
      });

      const cfg = makeCfg(home, {
        bindings: [
          {
            agentId: "coder",
            match: {
              channel: "telegram",
              peer: { kind: "dm", id: "12345" },
            },
          },
        ],
      });

      const route = resolveAgentRoute({
        cfg,
        channel: "telegram",
        accountId: null,
        peer: { kind: "dm", id: "12345" },
      });
      // Agent "coder" doesn't exist in agents.list, so it falls back to
      // the default agent but still returns the binding match type.
      expect(route.matchedBy).toBe("binding.peer");
    });
  });

  it("returns an error reply when the agent throws", async () => {
    await withTempHome(async (home) => {
      vi.mocked(runEmbeddedPiAgent).mockRejectedValue(new Error("model rate limit exceeded"));

      const cfg = makeCfg(home);

      const res = await getReplyFromConfig(
        {
          Body: "hello",
          From: "+15551234567",
          To: "+1999",
          Provider: "whatsapp",
        },
        {},
        cfg,
      );

      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(text).toContain("model rate limit exceeded");
      expect(runEmbeddedPiAgent).toHaveBeenCalledOnce();
    });
  });

  it("uses per-peer session isolation when configured", async () => {
    await withTempHome(async (home) => {
      const cfg = makeCfg(home, {
        session: {
          store: join(home, "sessions.json"),
          dmScope: "per-peer",
        },
      });

      const routeA = resolveAgentRoute({
        cfg,
        channel: "whatsapp",
        accountId: null,
        peer: { kind: "dm", id: "+1111" },
      });

      const routeB = resolveAgentRoute({
        cfg,
        channel: "whatsapp",
        accountId: null,
        peer: { kind: "dm", id: "+2222" },
      });

      expect(routeA.sessionKey).toBe("agent:main:dm:+1111");
      expect(routeB.sessionKey).toBe("agent:main:dm:+2222");
      expect(routeA.sessionKey).not.toBe(routeB.sessionKey);
    });
  });

  it("routes group messages to the default agent with group session key", async () => {
    await withTempHome(async (home) => {
      const cfg = makeCfg(home);

      const route = resolveAgentRoute({
        cfg,
        channel: "whatsapp",
        accountId: null,
        peer: { kind: "group", id: "groupchat@g.us" },
      });

      expect(route.agentId).toBe("main");
      expect(route.sessionKey).toBe("agent:main:whatsapp:group:groupchat@g.us");
    });
  });

  it("routes multi-account setups to the correct account", async () => {
    await withTempHome(async (home) => {
      const cfg = makeCfg(home, {
        bindings: [
          {
            agentId: "main",
            match: {
              channel: "discord",
              accountId: "work-bot",
            },
          },
        ],
      });

      const route = resolveAgentRoute({
        cfg,
        channel: "discord",
        accountId: "work-bot",
        peer: { kind: "dm", id: "user123" },
      });

      expect(route.agentId).toBe("main");
      expect(route.accountId).toBe("work-bot");
      expect(route.matchedBy).toBe("binding.account");
    });
  });
});
