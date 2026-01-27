import { join } from "node:path";
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
  it("shows a /model summary and points to /models", async () => {
    await withTempHome(async (home) => {
      const cfg = makeCfg(home);
      const res = await getReplyFromConfig(
        {
          Body: "/model",
          From: "telegram:111",
          To: "telegram:111",
          ChatType: "direct",
          Provider: "telegram",
          Surface: "telegram",
          SessionKey: "telegram:slash:111",
          CommandAuthorized: true,
        },
        {},
        cfg,
      );

      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      const normalized = normalizeTestText(text ?? "");
      expect(normalized).toContain("Current: anthropic/claude-opus-4-5");
      expect(normalized).toContain("Switch: /model <provider/model>");
      expect(normalized).toContain("Browse: /models (providers) or /models <provider> (models)");
      expect(normalized).toContain("More: /model status");
      expect(normalized).not.toContain("reasoning");
      expect(normalized).not.toContain("image");
    });
  });
  it("aliases /model list to /models", async () => {
    await withTempHome(async (home) => {
      const cfg = makeCfg(home);
      const res = await getReplyFromConfig(
        {
          Body: "/model list",
          From: "telegram:111",
          To: "telegram:111",
          ChatType: "direct",
          Provider: "telegram",
          Surface: "telegram",
          SessionKey: "telegram:slash:111",
          CommandAuthorized: true,
        },
        {},
        cfg,
      );

      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      const normalized = normalizeTestText(text ?? "");
      expect(normalized).toContain("Providers:");
      expect(normalized).toContain("Use: /models <provider>");
      expect(normalized).toContain("Switch: /model <provider/model>");
    });
  });
  it("selects the exact provider/model pair for openrouter", async () => {
    await withTempHome(async (home) => {
      const cfg = makeCfg(home);
      const sessionKey = "telegram:slash:111";

      const res = await getReplyFromConfig(
        {
          Body: "/model openrouter/anthropic/claude-opus-4-5",
          From: "telegram:111",
          To: "telegram:111",
          ChatType: "direct",
          Provider: "telegram",
          Surface: "telegram",
          SessionKey: sessionKey,
          CommandAuthorized: true,
        },
        {},
        cfg,
      );

      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(normalizeTestText(text ?? "")).toContain(
        "Model set to openrouter/anthropic/claude-opus-4-5",
      );

      const store = loadSessionStore(cfg.session.store);
      expect(store[sessionKey]?.providerOverride).toBe("openrouter");
      expect(store[sessionKey]?.modelOverride).toBe("anthropic/claude-opus-4-5");
    });
  });
  it("rejects invalid /model <#> selections", async () => {
    await withTempHome(async (home) => {
      const cfg = makeCfg(home);
      const sessionKey = "telegram:slash:111";

      const res = await getReplyFromConfig(
        {
          Body: "/model 99",
          From: "telegram:111",
          To: "telegram:111",
          ChatType: "direct",
          Provider: "telegram",
          Surface: "telegram",
          SessionKey: sessionKey,
          CommandAuthorized: true,
        },
        {},
        cfg,
      );

      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      const normalized = normalizeTestText(text ?? "");
      expect(normalized).toContain("Numeric model selection is not supported in chat.");
      expect(normalized).toContain("Browse: /models or /models <provider>");
      expect(normalized).toContain("Switch: /model <provider/model>");

      const store = loadSessionStore(cfg.session.store);
      expect(store[sessionKey]?.providerOverride).toBeUndefined();
      expect(store[sessionKey]?.modelOverride).toBeUndefined();
    });
  });
  it("resets to the default model via /model <provider/model>", async () => {
    await withTempHome(async (home) => {
      const cfg = makeCfg(home);
      const sessionKey = "telegram:slash:111";

      const res = await getReplyFromConfig(
        {
          Body: "/model anthropic/claude-opus-4-5",
          From: "telegram:111",
          To: "telegram:111",
          ChatType: "direct",
          Provider: "telegram",
          Surface: "telegram",
          SessionKey: sessionKey,
          CommandAuthorized: true,
        },
        {},
        cfg,
      );

      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(normalizeTestText(text ?? "")).toContain(
        "Model reset to default (anthropic/claude-opus-4-5)",
      );

      const store = loadSessionStore(cfg.session.store);
      // When selecting the default, overrides are cleared
      expect(store[sessionKey]?.providerOverride).toBeUndefined();
      expect(store[sessionKey]?.modelOverride).toBeUndefined();
    });
  });
  it("selects a model via /model <provider/model>", async () => {
    await withTempHome(async (home) => {
      const cfg = makeCfg(home);
      const sessionKey = "telegram:slash:111";

      const res = await getReplyFromConfig(
        {
          Body: "/model openai/gpt-5.2",
          From: "telegram:111",
          To: "telegram:111",
          ChatType: "direct",
          Provider: "telegram",
          Surface: "telegram",
          SessionKey: sessionKey,
          CommandAuthorized: true,
        },
        {},
        cfg,
      );

      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(normalizeTestText(text ?? "")).toContain("Model set to openai/gpt-5.2");

      const store = loadSessionStore(cfg.session.store);
      expect(store[sessionKey]?.providerOverride).toBe("openai");
      expect(store[sessionKey]?.modelOverride).toBe("gpt-5.2");
    });
  });
});
