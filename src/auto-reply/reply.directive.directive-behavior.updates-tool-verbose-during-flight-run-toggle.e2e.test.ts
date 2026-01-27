import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withTempHome as withTempHomeBase } from "../../test/helpers/temp-home.js";
import { loadModelCatalog } from "../agents/model-catalog.js";
import { runEmbeddedPiAgent } from "../agents/pi-embedded.js";
import { loadSessionStore, resolveSessionKey, saveSessionStore } from "../config/sessions.js";
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

function _assertModelSelection(
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

  it("updates tool verbose during an in-flight run (toggle on)", async () => {
    await withTempHome(async (home) => {
      const storePath = path.join(home, "sessions.json");
      const ctx = { Body: "please do the thing", From: "+1004", To: "+2000" };
      const sessionKey = resolveSessionKey(
        "per-sender",
        { From: ctx.From, To: ctx.To, Body: ctx.Body },
        "main",
      );

      vi.mocked(runEmbeddedPiAgent).mockImplementation(async (params) => {
        const shouldEmit = params.shouldEmitToolResult;
        expect(shouldEmit?.()).toBe(false);
        const store = loadSessionStore(storePath);
        const entry = store[sessionKey] ?? {
          sessionId: "s",
          updatedAt: Date.now(),
        };
        store[sessionKey] = {
          ...entry,
          verboseLevel: "on",
          updatedAt: Date.now(),
        };
        await saveSessionStore(storePath, store);
        expect(shouldEmit?.()).toBe(true);
        return {
          payloads: [{ text: "done" }],
          meta: {
            durationMs: 5,
            agentMeta: { sessionId: "s", provider: "p", model: "m" },
          },
        };
      });

      const res = await getReplyFromConfig(
        ctx,
        {},
        {
          agents: {
            defaults: {
              model: "anthropic/claude-opus-4-5",
              workspace: path.join(home, "clawd"),
            },
          },
          channels: { whatsapp: { allowFrom: ["*"] } },
          session: { store: storePath },
        },
      );

      const texts = (Array.isArray(res) ? res : [res]).map((entry) => entry?.text).filter(Boolean);
      expect(texts).toContain("done");
      expect(runEmbeddedPiAgent).toHaveBeenCalledOnce();
    });
  });
  it("updates tool verbose during an in-flight run (toggle off)", async () => {
    await withTempHome(async (home) => {
      const storePath = path.join(home, "sessions.json");
      const ctx = {
        Body: "please do the thing",
        From: "+1004",
        To: "+2000",
      };
      const sessionKey = resolveSessionKey(
        "per-sender",
        { From: ctx.From, To: ctx.To, Body: ctx.Body },
        "main",
      );

      vi.mocked(runEmbeddedPiAgent).mockImplementation(async (params) => {
        const shouldEmit = params.shouldEmitToolResult;
        expect(shouldEmit?.()).toBe(true);
        const store = loadSessionStore(storePath);
        const entry = store[sessionKey] ?? {
          sessionId: "s",
          updatedAt: Date.now(),
        };
        store[sessionKey] = {
          ...entry,
          verboseLevel: "off",
          updatedAt: Date.now(),
        };
        await saveSessionStore(storePath, store);
        expect(shouldEmit?.()).toBe(false);
        return {
          payloads: [{ text: "done" }],
          meta: {
            durationMs: 5,
            agentMeta: { sessionId: "s", provider: "p", model: "m" },
          },
        };
      });

      await getReplyFromConfig(
        { Body: "/verbose on", From: ctx.From, To: ctx.To, CommandAuthorized: true },
        {},
        {
          agents: {
            defaults: {
              model: "anthropic/claude-opus-4-5",
              workspace: path.join(home, "clawd"),
            },
          },
          channels: { whatsapp: { allowFrom: ["*"] } },
          session: { store: storePath },
        },
      );

      const res = await getReplyFromConfig(
        ctx,
        {},
        {
          agents: {
            defaults: {
              model: "anthropic/claude-opus-4-5",
              workspace: path.join(home, "clawd"),
            },
          },
          channels: { whatsapp: { allowFrom: ["*"] } },
          session: { store: storePath },
        },
      );

      const texts = (Array.isArray(res) ? res : [res]).map((entry) => entry?.text).filter(Boolean);
      expect(texts).toContain("done");
      expect(runEmbeddedPiAgent).toHaveBeenCalledOnce();
    });
  });
  it("shows summary on /model", async () => {
    await withTempHome(async (home) => {
      vi.mocked(runEmbeddedPiAgent).mockReset();
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
      expect(text).not.toContain("openai/gpt-4.1-mini");
      expect(runEmbeddedPiAgent).not.toHaveBeenCalled();
    });
  });
  it("lists allowlisted models on /model status", async () => {
    await withTempHome(async (home) => {
      vi.mocked(runEmbeddedPiAgent).mockReset();
      const storePath = path.join(home, "sessions.json");

      const res = await getReplyFromConfig(
        { Body: "/model status", From: "+1222", To: "+1222", CommandAuthorized: true },
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
      expect(text).toContain("anthropic/claude-opus-4-5");
      expect(text).toContain("openai/gpt-4.1-mini");
      expect(text).not.toContain("claude-sonnet-4-1");
      expect(text).toContain("auth:");
      expect(runEmbeddedPiAgent).not.toHaveBeenCalled();
    });
  });
});
