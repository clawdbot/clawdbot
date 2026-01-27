import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withTempHome as withTempHomeBase } from "../../test/helpers/temp-home.js";
import { loadModelCatalog } from "../agents/model-catalog.js";
import { runEmbeddedPiAgent } from "../agents/pi-embedded.js";
import { loadSessionStore } from "../config/sessions.js";
import { getReplyFromConfig } from "./reply.js";

const MAIN_SESSION_KEY = "agent:main:main";

vi.mock("../agents/pi-embedded.js", () => ({
  abortEmbeddedPiRun: vi.fn().mockReturnValue(false),
  runEmbeddedPiAgent: vi.fn(),
  queueEmbeddedPiMessage: vi.fn().mockReturnValue(false),
  resolveEmbeddedSessionLane: (key: string) => `session:${key.trim() || "main"}`,
  isEmbeddedPiRunActive: vi.fn().mockReturnValue(false),
  isEmbeddedPiRunStreaming: vi.fn().mockReturnValue(false),
}));
vi.mock("../agents/model-catalog.js", () => ({
  loadModelCatalog: vi.fn(),
}));

async function withTempHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  return withTempHomeBase(
    async (home) => {
      return await fn(home);
    },
    {
      env: {
        CLAWDBOT_AGENT_DIR: (home) => path.join(home, ".clawdbot", "agent"),
        PI_CODING_AGENT_DIR: (home) => path.join(home, ".clawdbot", "agent"),
      },
      prefix: "moltbot-reply-",
    },
  );
}

function assertModelSelection(
  storePath: string,
  selection: { model?: string; provider?: string } = {},
) {
  const store = loadSessionStore(storePath);
  const entry = store[MAIN_SESSION_KEY];
  expect(entry).toBeDefined();
  expect(entry?.modelOverride).toBe(selection.model);
  expect(entry?.providerOverride).toBe(selection.provider);
}

describe("directive behavior", () => {
  beforeEach(() => {
    vi.mocked(runEmbeddedPiAgent).mockReset();
    vi.mocked(loadModelCatalog).mockResolvedValue([
      { id: "claude-opus-4-5", name: "Opus 4.5", provider: "anthropic" },
      { id: "claude-sonnet-4-1", name: "Sonnet 4.1", provider: "anthropic" },
      { id: "gpt-4.1-mini", name: "GPT-4.1 Mini", provider: "openai" },
    ]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("aliases /model list to /models", async () => {
    await withTempHome(async (home) => {
      vi.mocked(runEmbeddedPiAgent).mockReset();
      const storePath = path.join(home, "sessions.json");

      const res = await getReplyFromConfig(
        { Body: "/model list", From: "+1222", To: "+1222", CommandAuthorized: true },
        {},
        {
          agents: {
            defaults: {
              model: { primary: "anthropic/claude-opus-4-5" },
              workspace: path.join(home, "clawd"),
              models: {
                "anthropic/claude-opus-4-5": {},
                "openai/gpt-4.1-mini": {},
              },
            },
          },
          session: { store: storePath },
        },
      );

      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(text).toContain("Providers:");
      expect(text).toContain("- anthropic");
      expect(text).toContain("- openai");
      expect(text).toContain("Use: /models <provider>");
      expect(text).toContain("Switch: /model <provider/model>");
      expect(runEmbeddedPiAgent).not.toHaveBeenCalled();
    });
  });
  it("shows current model when catalog is unavailable", async () => {
    await withTempHome(async (home) => {
      vi.mocked(runEmbeddedPiAgent).mockReset();
      vi.mocked(loadModelCatalog).mockResolvedValueOnce([]);
      const storePath = path.join(home, "sessions.json");

      const res = await getReplyFromConfig(
        { Body: "/model", From: "+1222", To: "+1222", CommandAuthorized: true },
        {},
        {
          agents: {
            defaults: {
              model: { primary: "anthropic/claude-opus-4-5" },
              workspace: path.join(home, "clawd"),
              models: {
                "anthropic/claude-opus-4-5": {},
                "openai/gpt-4.1-mini": {},
              },
            },
          },
          session: { store: storePath },
        },
      );

      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(text).toContain("Current: anthropic/claude-opus-4-5");
      expect(text).toContain("Switch: /model <provider/model>");
      expect(text).toContain("Browse: /models (providers) or /models <provider> (models)");
      expect(text).toContain("More: /model status");
      expect(runEmbeddedPiAgent).not.toHaveBeenCalled();
    });
  });
  it("includes catalog providers when no allowlist is set", async () => {
    await withTempHome(async (home) => {
      vi.mocked(runEmbeddedPiAgent).mockReset();
      vi.mocked(loadModelCatalog).mockResolvedValue([
        { id: "claude-opus-4-5", name: "Opus 4.5", provider: "anthropic" },
        { id: "gpt-4.1-mini", name: "GPT-4.1 Mini", provider: "openai" },
        { id: "grok-4", name: "Grok 4", provider: "xai" },
      ]);
      const storePath = path.join(home, "sessions.json");

      const res = await getReplyFromConfig(
        { Body: "/model list", From: "+1222", To: "+1222", CommandAuthorized: true },
        {},
        {
          agents: {
            defaults: {
              model: {
                primary: "anthropic/claude-opus-4-5",
                fallbacks: ["openai/gpt-4.1-mini"],
              },
              imageModel: { primary: "minimax/MiniMax-M2.1" },
              workspace: path.join(home, "clawd"),
            },
          },
          session: { store: storePath },
        },
      );

      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(text).toContain("Providers:");
      expect(text).toContain("- anthropic");
      expect(text).toContain("- openai");
      expect(text).toContain("- xai");
      expect(text).toContain("Use: /models <provider>");
      expect(runEmbeddedPiAgent).not.toHaveBeenCalled();
    });
  });
  it("lists config-only providers when catalog is present", async () => {
    await withTempHome(async (home) => {
      vi.mocked(runEmbeddedPiAgent).mockReset();
      // Catalog present but missing custom providers: /model should still include
      // allowlisted provider/model keys from config.
      vi.mocked(loadModelCatalog).mockResolvedValueOnce([
        {
          provider: "anthropic",
          id: "claude-opus-4-5",
          name: "Claude Opus 4.5",
        },
        { provider: "openai", id: "gpt-4.1-mini", name: "GPT-4.1 mini" },
      ]);
      const storePath = path.join(home, "sessions.json");

      const res = await getReplyFromConfig(
        { Body: "/models minimax", From: "+1222", To: "+1222", CommandAuthorized: true },
        {},
        {
          agents: {
            defaults: {
              model: { primary: "anthropic/claude-opus-4-5" },
              workspace: path.join(home, "clawd"),
              models: {
                "anthropic/claude-opus-4-5": {},
                "openai/gpt-4.1-mini": {},
                "minimax/MiniMax-M2.1": { alias: "minimax" },
              },
            },
          },
          models: {
            mode: "merge",
            providers: {
              minimax: {
                baseUrl: "https://api.minimax.io/anthropic",
                api: "anthropic-messages",
                models: [{ id: "MiniMax-M2.1", name: "MiniMax M2.1" }],
              },
            },
          },
          session: { store: storePath },
        },
      );

      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(text).toContain("Model set to minimax");
      expect(text).toContain("minimax/MiniMax-M2.1");
      expect(runEmbeddedPiAgent).not.toHaveBeenCalled();
    });
  });
  it("does not repeat missing auth labels on /model list", async () => {
    await withTempHome(async (home) => {
      vi.mocked(runEmbeddedPiAgent).mockReset();
      const storePath = path.join(home, "sessions.json");

      const res = await getReplyFromConfig(
        { Body: "/model list", From: "+1222", To: "+1222", CommandAuthorized: true },
        {},
        {
          agents: {
            defaults: {
              model: { primary: "anthropic/claude-opus-4-5" },
              workspace: path.join(home, "clawd"),
              models: {
                "anthropic/claude-opus-4-5": {},
              },
            },
          },
          session: { store: storePath },
        },
      );

      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(text).toContain("Providers:");
      expect(text).not.toContain("missing (missing)");
      expect(runEmbeddedPiAgent).not.toHaveBeenCalled();
    });
  });
  it("sets model override on /model directive", async () => {
    await withTempHome(async (home) => {
      vi.mocked(runEmbeddedPiAgent).mockReset();
      const storePath = path.join(home, "sessions.json");

      await getReplyFromConfig(
        { Body: "/model openai/gpt-4.1-mini", From: "+1222", To: "+1222", CommandAuthorized: true },
        {},
        {
          agents: {
            defaults: {
              model: { primary: "anthropic/claude-opus-4-5" },
              workspace: path.join(home, "clawd"),
              models: {
                "anthropic/claude-opus-4-5": {},
                "openai/gpt-4.1-mini": {},
              },
            },
          },
          session: { store: storePath },
        },
      );

      assertModelSelection(storePath, {
        model: "gpt-4.1-mini",
        provider: "openai",
      });
      expect(runEmbeddedPiAgent).not.toHaveBeenCalled();
    });
  });
  it("supports model aliases on /model directive", async () => {
    await withTempHome(async (home) => {
      vi.mocked(runEmbeddedPiAgent).mockReset();
      const storePath = path.join(home, "sessions.json");

      await getReplyFromConfig(
        { Body: "/model Opus", From: "+1222", To: "+1222", CommandAuthorized: true },
        {},
        {
          agents: {
            defaults: {
              model: { primary: "openai/gpt-4.1-mini" },
              workspace: path.join(home, "clawd"),
              models: {
                "openai/gpt-4.1-mini": {},
                "anthropic/claude-opus-4-5": { alias: "Opus" },
              },
            },
          },
          session: { store: storePath },
        },
      );

      assertModelSelection(storePath, {
        model: "claude-opus-4-5",
        provider: "anthropic",
      });
      expect(runEmbeddedPiAgent).not.toHaveBeenCalled();
    });
  });
});
