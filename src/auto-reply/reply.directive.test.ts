import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loadModelCatalog } from "../agents/model-catalog.js";
import { runEmbeddedPiAgent } from "../agents/pi-embedded.js";
import {
  loadSessionStore,
  resolveSessionKey,
  saveSessionStore,
} from "../config/sessions.js";
import { drainSystemEvents } from "../infra/system-events.js";
import {
  extractElevatedDirective,
  extractQueueDirective,
  extractReplyToTag,
  extractThinkDirective,
  extractVerboseDirective,
  getReplyFromConfig,
} from "./reply.js";

vi.mock("../agents/pi-embedded.js", () => ({
  abortEmbeddedPiRun: vi.fn().mockReturnValue(false),
  runEmbeddedPiAgent: vi.fn(),
  queueEmbeddedPiMessage: vi.fn().mockReturnValue(false),
  resolveEmbeddedSessionLane: (key: string) =>
    `session:${key.trim() || "main"}`,
  isEmbeddedPiRunActive: vi.fn().mockReturnValue(false),
  isEmbeddedPiRunStreaming: vi.fn().mockReturnValue(false),
}));
vi.mock("../agents/model-catalog.js", () => ({
  loadModelCatalog: vi.fn(),
}));

async function withTempHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-reply-"));
  const previousHome = process.env.HOME;
  process.env.HOME = base;
  try {
    return await fn(base);
  } finally {
    process.env.HOME = previousHome;
    await fs.rm(base, { recursive: true, force: true });
  }
}

describe("directive parsing", () => {
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

  it("ignores verbose directive inside URL", () => {
    const body = "https://x.com/verioussmith/status/1997066835133669687";
    const res = extractVerboseDirective(body);
    expect(res.hasDirective).toBe(false);
    expect(res.cleaned).toBe(body);
  });

  it("ignores typoed /verioussmith", () => {
    const body = "/verioussmith";
    const res = extractVerboseDirective(body);
    expect(res.hasDirective).toBe(false);
    expect(res.cleaned).toBe(body.trim());
  });

  it("ignores think directive inside URL", () => {
    const body = "see https://example.com/path/thinkstuff";
    const res = extractThinkDirective(body);
    expect(res.hasDirective).toBe(false);
  });

  it("matches verbose with leading space", () => {
    const res = extractVerboseDirective(" please /verbose on now");
    expect(res.hasDirective).toBe(true);
    expect(res.verboseLevel).toBe("on");
  });

  it("matches elevated with leading space", () => {
    const res = extractElevatedDirective(" please /elevated on now");
    expect(res.hasDirective).toBe(true);
    expect(res.elevatedLevel).toBe("on");
  });

  it("matches think at start of line", () => {
    const res = extractThinkDirective("/think:high run slow");
    expect(res.hasDirective).toBe(true);
    expect(res.thinkLevel).toBe("high");
  });

  it("matches queue directive", () => {
    const res = extractQueueDirective("please /queue interrupt now");
    expect(res.hasDirective).toBe(true);
    expect(res.queueMode).toBe("interrupt");
    expect(res.queueReset).toBe(false);
    expect(res.cleaned).toBe("please now");
  });

  it("parses queue options and modes", () => {
    const res = extractQueueDirective(
      "please /queue steer+backlog debounce:2s cap:5 drop:summarize now",
    );
    expect(res.hasDirective).toBe(true);
    expect(res.queueMode).toBe("steer-backlog");
    expect(res.debounceMs).toBe(2000);
    expect(res.cap).toBe(5);
    expect(res.dropPolicy).toBe("summarize");
    expect(res.cleaned).toBe("please now");
  });

  it("errors on invalid queue options", async () => {
    await withTempHome(async (home) => {
      vi.mocked(runEmbeddedPiAgent).mockReset();

      const res = await getReplyFromConfig(
        {
          Body: "/queue collect debounce:bogus cap:zero drop:maybe",
          From: "+1222",
          To: "+1222",
        },
        {},
        {
          agent: {
            model: "anthropic/claude-opus-4-5",
            workspace: path.join(home, "clawd"),
          },
          whatsapp: { allowFrom: ["*"] },
          session: { store: path.join(home, "sessions.json") },
        },
      );

      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(text).toContain("Invalid debounce");
      expect(text).toContain("Invalid cap");
      expect(text).toContain("Invalid drop policy");
      expect(runEmbeddedPiAgent).not.toHaveBeenCalled();
    });
  });

  it("extracts reply_to_current tag", () => {
    const res = extractReplyToTag("ok [[reply_to_current]]", "msg-1");
    expect(res.replyToId).toBe("msg-1");
    expect(res.cleaned).toBe("ok");
  });

  it("extracts reply_to id tag", () => {
    const res = extractReplyToTag("see [[reply_to:12345]] now", "msg-1");
    expect(res.replyToId).toBe("12345");
    expect(res.cleaned).toBe("see now");
  });

  it("preserves newlines when stripping reply tags", () => {
    const res = extractReplyToTag(
      "line 1\nline 2 [[reply_to_current]]\n\nline 3",
      "msg-2",
    );
    expect(res.replyToId).toBe("msg-2");
    expect(res.cleaned).toBe("line 1\nline 2\n\nline 3");
  });

  it("strips reply tags and maps reply_to_current to MessageSid", async () => {
    await withTempHome(async (home) => {
      vi.mocked(runEmbeddedPiAgent).mockResolvedValue({
        payloads: [{ text: "hello [[reply_to_current]]" }],
        meta: {
          durationMs: 5,
          agentMeta: { sessionId: "s", provider: "p", model: "m" },
        },
      });

      const res = await getReplyFromConfig(
        {
          Body: "ping",
          From: "+1004",
          To: "+2000",
          MessageSid: "msg-123",
        },
        {},
        {
          agent: {
            model: "anthropic/claude-opus-4-5",
            workspace: path.join(home, "clawd"),
          },
          whatsapp: { allowFrom: ["*"] },
          session: { store: path.join(home, "sessions.json") },
        },
      );

      const payload = Array.isArray(res) ? res[0] : res;
      expect(payload?.text).toBe("hello");
      expect(payload?.replyToId).toBe("msg-123");
    });
  });

  it("prefers explicit reply_to id over reply_to_current", async () => {
    await withTempHome(async (home) => {
      vi.mocked(runEmbeddedPiAgent).mockResolvedValue({
        payloads: [
          {
            text: "hi [[reply_to_current]] [[reply_to:abc-456]]",
          },
        ],
        meta: {
          durationMs: 5,
          agentMeta: { sessionId: "s", provider: "p", model: "m" },
        },
      });

      const res = await getReplyFromConfig(
        {
          Body: "ping",
          From: "+1004",
          To: "+2000",
          MessageSid: "msg-123",
        },
        {},
        {
          agent: {
            model: "anthropic/claude-opus-4-5",
            workspace: path.join(home, "clawd"),
          },
          whatsapp: { allowFrom: ["*"] },
          session: { store: path.join(home, "sessions.json") },
        },
      );

      const payload = Array.isArray(res) ? res[0] : res;
      expect(payload?.text).toBe("hi");
      expect(payload?.replyToId).toBe("abc-456");
    });
  });

  it("applies inline think and still runs agent content", async () => {
    await withTempHome(async (home) => {
      vi.mocked(runEmbeddedPiAgent).mockResolvedValue({
        payloads: [{ text: "done" }],
        meta: {
          durationMs: 5,
          agentMeta: { sessionId: "s", provider: "p", model: "m" },
        },
      });

      const res = await getReplyFromConfig(
        {
          Body: "please sync /think:high now",
          From: "+1004",
          To: "+2000",
        },
        {},
        {
          agent: {
            model: "anthropic/claude-opus-4-5",
            workspace: path.join(home, "clawd"),
          },
          whatsapp: {
            allowFrom: ["*"],
          },
          session: { store: path.join(home, "sessions.json") },
        },
      );

      const texts = (Array.isArray(res) ? res : [res])
        .map((entry) => entry?.text)
        .filter(Boolean);
      expect(texts).toContain("done");
      expect(runEmbeddedPiAgent).toHaveBeenCalledOnce();
    });
  });

  it("acks verbose directive immediately with system marker", async () => {
    await withTempHome(async (home) => {
      vi.mocked(runEmbeddedPiAgent).mockReset();

      const res = await getReplyFromConfig(
        { Body: "/verbose on", From: "+1222", To: "+1222" },
        {},
        {
          agent: {
            model: "anthropic/claude-opus-4-5",
            workspace: path.join(home, "clawd"),
          },
          session: { store: path.join(home, "sessions.json") },
        },
      );

      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(text).toMatch(/^⚙️ Verbose logging enabled\./);
      expect(runEmbeddedPiAgent).not.toHaveBeenCalled();
    });
  });

  it("rejects invalid elevated level", async () => {
    await withTempHome(async (home) => {
      vi.mocked(runEmbeddedPiAgent).mockReset();

      const res = await getReplyFromConfig(
        {
          Body: "/elevated maybe",
          From: "+1222",
          To: "+1222",
          Surface: "whatsapp",
          SenderE164: "+1222",
        },
        {},
        {
          agent: {
            model: "anthropic/claude-opus-4-5",
            workspace: path.join(home, "clawd"),
            elevated: {
              allowFrom: { whatsapp: ["+1222"] },
            },
          },
          whatsapp: { allowFrom: ["+1222"] },
          session: { store: path.join(home, "sessions.json") },
        },
      );

      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(text).toContain("Unrecognized elevated level");
      expect(runEmbeddedPiAgent).not.toHaveBeenCalled();
    });
  });

  it("acks queue directive and persists override", async () => {
    await withTempHome(async (home) => {
      vi.mocked(runEmbeddedPiAgent).mockReset();
      const storePath = path.join(home, "sessions.json");

      const res = await getReplyFromConfig(
        { Body: "/queue interrupt", From: "+1222", To: "+1222" },
        {},
        {
          agent: {
            model: "anthropic/claude-opus-4-5",
            workspace: path.join(home, "clawd"),
          },
          whatsapp: { allowFrom: ["*"] },
          session: { store: storePath },
        },
      );

      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(text).toMatch(/^⚙️ Queue mode set to interrupt\./);
      const store = loadSessionStore(storePath);
      const entry = Object.values(store)[0];
      expect(entry?.queueMode).toBe("interrupt");
      expect(runEmbeddedPiAgent).not.toHaveBeenCalled();
    });
  });

  it("persists queue options when directive is standalone", async () => {
    await withTempHome(async (home) => {
      vi.mocked(runEmbeddedPiAgent).mockReset();
      const storePath = path.join(home, "sessions.json");

      const res = await getReplyFromConfig(
        {
          Body: "/queue collect debounce:2s cap:5 drop:old",
          From: "+1222",
          To: "+1222",
        },
        {},
        {
          agent: {
            model: "anthropic/claude-opus-4-5",
            workspace: path.join(home, "clawd"),
          },
          whatsapp: { allowFrom: ["*"] },
          session: { store: storePath },
        },
      );

      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(text).toMatch(/^⚙️ Queue mode set to collect\./);
      expect(text).toMatch(/Queue debounce set to 2000ms/);
      expect(text).toMatch(/Queue cap set to 5/);
      expect(text).toMatch(/Queue drop set to old/);
      const store = loadSessionStore(storePath);
      const entry = Object.values(store)[0];
      expect(entry?.queueMode).toBe("collect");
      expect(entry?.queueDebounceMs).toBe(2000);
      expect(entry?.queueCap).toBe(5);
      expect(entry?.queueDrop).toBe("old");
      expect(runEmbeddedPiAgent).not.toHaveBeenCalled();
    });
  });

  it("resets queue mode to default", async () => {
    await withTempHome(async (home) => {
      vi.mocked(runEmbeddedPiAgent).mockReset();
      const storePath = path.join(home, "sessions.json");

      await getReplyFromConfig(
        { Body: "/queue interrupt", From: "+1222", To: "+1222" },
        {},
        {
          agent: {
            model: "anthropic/claude-opus-4-5",
            workspace: path.join(home, "clawd"),
          },
          whatsapp: { allowFrom: ["*"] },
          session: { store: storePath },
        },
      );

      const res = await getReplyFromConfig(
        { Body: "/queue reset", From: "+1222", To: "+1222" },
        {},
        {
          agent: {
            model: "anthropic/claude-opus-4-5",
            workspace: path.join(home, "clawd"),
          },
          whatsapp: { allowFrom: ["*"] },
          session: { store: storePath },
        },
      );

      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(text).toMatch(/^⚙️ Queue mode reset to default\./);
      const store = loadSessionStore(storePath);
      const entry = Object.values(store)[0];
      expect(entry?.queueMode).toBeUndefined();
      expect(entry?.queueDebounceMs).toBeUndefined();
      expect(entry?.queueCap).toBeUndefined();
      expect(entry?.queueDrop).toBeUndefined();
      expect(runEmbeddedPiAgent).not.toHaveBeenCalled();
    });
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
          agent: {
            model: "anthropic/claude-opus-4-5",
            workspace: path.join(home, "clawd"),
          },
          whatsapp: {
            allowFrom: ["*"],
          },
          session: { store: storePath },
        },
      );

      const texts = (Array.isArray(res) ? res : [res])
        .map((entry) => entry?.text)
        .filter(Boolean);
      expect(texts).toContain("done");
      expect(runEmbeddedPiAgent).toHaveBeenCalledOnce();
    });
  });

  it("updates tool verbose during an in-flight run (toggle off)", async () => {
    await withTempHome(async (home) => {
      const storePath = path.join(home, "sessions.json");
      const ctx = {
        Body: "please do the thing /verbose on",
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

      const res = await getReplyFromConfig(
        ctx,
        {},
        {
          agent: {
            model: "anthropic/claude-opus-4-5",
            workspace: path.join(home, "clawd"),
          },
          whatsapp: {
            allowFrom: ["*"],
          },
          session: { store: storePath },
        },
      );

      const texts = (Array.isArray(res) ? res : [res])
        .map((entry) => entry?.text)
        .filter(Boolean);
      expect(texts).toContain("done");
      expect(runEmbeddedPiAgent).toHaveBeenCalledOnce();
    });
  });

  it("lists allowlisted models on /model", async () => {
    await withTempHome(async (home) => {
      vi.mocked(runEmbeddedPiAgent).mockReset();
      const storePath = path.join(home, "sessions.json");

      const res = await getReplyFromConfig(
        { Body: "/model", From: "+1222", To: "+1222" },
        {},
        {
          agent: {
            model: "anthropic/claude-opus-4-5",
            workspace: path.join(home, "clawd"),
            allowedModels: ["anthropic/claude-opus-4-5", "openai/gpt-4.1-mini"],
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

  it("lists allowlisted models on /model status", async () => {
    await withTempHome(async (home) => {
      vi.mocked(runEmbeddedPiAgent).mockReset();
      const storePath = path.join(home, "sessions.json");

      const res = await getReplyFromConfig(
        { Body: "/model status", From: "+1222", To: "+1222" },
        {},
        {
          agent: {
            model: "anthropic/claude-opus-4-5",
            workspace: path.join(home, "clawd"),
            allowedModels: ["anthropic/claude-opus-4-5", "openai/gpt-4.1-mini"],
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

  it("lists allowlisted models on /model list", async () => {
    await withTempHome(async (home) => {
      vi.mocked(runEmbeddedPiAgent).mockReset();
      const storePath = path.join(home, "sessions.json");

      const res = await getReplyFromConfig(
        { Body: "/model list", From: "+1222", To: "+1222" },
        {},
        {
          agent: {
            model: "anthropic/claude-opus-4-5",
            workspace: path.join(home, "clawd"),
            allowedModels: ["anthropic/claude-opus-4-5", "openai/gpt-4.1-mini"],
          },
          session: { store: storePath },
        },
      );

      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(text).toContain("anthropic/claude-opus-4-5");
      expect(text).toContain("openai/gpt-4.1-mini");
      expect(text).toContain("auth:");
      expect(runEmbeddedPiAgent).not.toHaveBeenCalled();
    });
  });

  it("sets model override on /model directive", async () => {
    await withTempHome(async (home) => {
      vi.mocked(runEmbeddedPiAgent).mockReset();
      const storePath = path.join(home, "sessions.json");

      const res = await getReplyFromConfig(
        { Body: "/model openai/gpt-4.1-mini", From: "+1222", To: "+1222" },
        {},
        {
          agent: {
            model: "anthropic/claude-opus-4-5",
            workspace: path.join(home, "clawd"),
            allowedModels: ["openai/gpt-4.1-mini"],
          },
          session: { store: storePath },
        },
      );

      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(text).toContain("Model set to openai/gpt-4.1-mini");
      const store = loadSessionStore(storePath);
      const entry = store.main;
      expect(entry.modelOverride).toBe("gpt-4.1-mini");
      expect(entry.providerOverride).toBe("openai");
      expect(runEmbeddedPiAgent).not.toHaveBeenCalled();
    });
  });

  it("supports model aliases on /model directive", async () => {
    await withTempHome(async (home) => {
      vi.mocked(runEmbeddedPiAgent).mockReset();
      const storePath = path.join(home, "sessions.json");

      const res = await getReplyFromConfig(
        { Body: "/model Opus", From: "+1222", To: "+1222" },
        {},
        {
          agent: {
            model: "openai/gpt-4.1-mini",
            workspace: path.join(home, "clawd"),
            allowedModels: ["openai/gpt-4.1-mini", "anthropic/claude-opus-4-5"],
            modelAliases: {
              Opus: "anthropic/claude-opus-4-5",
            },
          },
          session: { store: storePath },
        },
      );

      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(text).toContain("Model set to Opus");
      expect(text).toContain("anthropic/claude-opus-4-5");
      const store = loadSessionStore(storePath);
      const entry = store.main;
      expect(entry.modelOverride).toBe("claude-opus-4-5");
      expect(entry.providerOverride).toBe("anthropic");
      expect(runEmbeddedPiAgent).not.toHaveBeenCalled();
    });
  });

  it("queues a system event when switching models", async () => {
    await withTempHome(async (home) => {
      drainSystemEvents();
      vi.mocked(runEmbeddedPiAgent).mockReset();
      const storePath = path.join(home, "sessions.json");

      await getReplyFromConfig(
        { Body: "/model Opus", From: "+1222", To: "+1222" },
        {},
        {
          agent: {
            model: "openai/gpt-4.1-mini",
            workspace: path.join(home, "clawd"),
            allowedModels: ["openai/gpt-4.1-mini", "anthropic/claude-opus-4-5"],
            modelAliases: {
              Opus: "anthropic/claude-opus-4-5",
            },
          },
          session: { store: storePath },
        },
      );

      const events = drainSystemEvents();
      expect(events).toContain(
        "Model switched to Opus (anthropic/claude-opus-4-5).",
      );
      expect(runEmbeddedPiAgent).not.toHaveBeenCalled();
    });
  });

  it("uses model override for inline /model", async () => {
    await withTempHome(async (home) => {
      const storePath = path.join(home, "sessions.json");
      vi.mocked(runEmbeddedPiAgent).mockResolvedValue({
        payloads: [{ text: "done" }],
        meta: {
          durationMs: 5,
          agentMeta: { sessionId: "s", provider: "p", model: "m" },
        },
      });

      const res = await getReplyFromConfig(
        {
          Body: "please sync /model openai/gpt-4.1-mini now",
          From: "+1004",
          To: "+2000",
        },
        {},
        {
          agent: {
            model: "anthropic/claude-opus-4-5",
            workspace: path.join(home, "clawd"),
            allowedModels: ["openai/gpt-4.1-mini"],
          },
          whatsapp: {
            allowFrom: ["*"],
          },
          session: { store: storePath },
        },
      );

      const texts = (Array.isArray(res) ? res : [res])
        .map((entry) => entry?.text)
        .filter(Boolean);
      expect(texts).toContain("done");
      expect(runEmbeddedPiAgent).toHaveBeenCalledOnce();
      const call = vi.mocked(runEmbeddedPiAgent).mock.calls[0]?.[0];
      expect(call?.provider).toBe("openai");
      expect(call?.model).toBe("gpt-4.1-mini");
    });
  });

  it("defaults thinking to low for reasoning-capable models", async () => {
    await withTempHome(async (home) => {
      const storePath = path.join(home, "sessions.json");
      vi.mocked(runEmbeddedPiAgent).mockResolvedValue({
        payloads: [{ text: "done" }],
        meta: {
          durationMs: 5,
          agentMeta: { sessionId: "s", provider: "p", model: "m" },
        },
      });
      vi.mocked(loadModelCatalog).mockResolvedValueOnce([
        {
          id: "claude-opus-4-5",
          name: "Opus 4.5",
          provider: "anthropic",
          reasoning: true,
        },
      ]);

      await getReplyFromConfig(
        {
          Body: "hello",
          From: "+1004",
          To: "+2000",
        },
        {},
        {
          agent: {
            model: "anthropic/claude-opus-4-5",
            workspace: path.join(home, "clawd"),
          },
          whatsapp: {
            allowFrom: ["*"],
          },
          session: { store: storePath },
        },
      );

      expect(runEmbeddedPiAgent).toHaveBeenCalledOnce();
      const call = vi.mocked(runEmbeddedPiAgent).mock.calls[0]?.[0];
      expect(call?.thinkLevel).toBe("low");
    });
  });

  it("passes elevated defaults when sender is approved", async () => {
    await withTempHome(async (home) => {
      const storePath = path.join(home, "sessions.json");
      vi.mocked(runEmbeddedPiAgent).mockResolvedValue({
        payloads: [{ text: "done" }],
        meta: {
          durationMs: 5,
          agentMeta: { sessionId: "s", provider: "p", model: "m" },
        },
      });

      await getReplyFromConfig(
        {
          Body: "hello",
          From: "+1004",
          To: "+2000",
          Surface: "whatsapp",
          SenderE164: "+1004",
        },
        {},
        {
          agent: {
            model: "anthropic/claude-opus-4-5",
            workspace: path.join(home, "clawd"),
            elevated: {
              allowFrom: { whatsapp: ["+1004"] },
            },
          },
          whatsapp: {
            allowFrom: ["*"],
          },
          session: { store: storePath },
        },
      );

      expect(runEmbeddedPiAgent).toHaveBeenCalledOnce();
      const call = vi.mocked(runEmbeddedPiAgent).mock.calls[0]?.[0];
      expect(call?.bashElevated).toEqual({
        enabled: true,
        allowed: true,
        defaultLevel: "on",
      });
    });
  });
});
