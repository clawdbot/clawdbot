import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../agents/pi-embedded.js", () => ({
  abortEmbeddedPiRun: vi.fn().mockReturnValue(false),
  compactEmbeddedPiSession: vi.fn(),
  runEmbeddedPiAgent: vi.fn(),
  queueEmbeddedPiMessage: vi.fn().mockReturnValue(false),
  resolveEmbeddedSessionLane: (key: string) =>
    `session:${key.trim() || "main"}`,
  isEmbeddedPiRunActive: vi.fn().mockReturnValue(false),
  isEmbeddedPiRunStreaming: vi.fn().mockReturnValue(false),
}));

import {
  compactEmbeddedPiSession,
  runEmbeddedPiAgent,
} from "../agents/pi-embedded.js";
import { ensureSandboxWorkspaceForSession } from "../agents/sandbox.js";
import { loadSessionStore, resolveSessionKey } from "../config/sessions.js";
import { getReplyFromConfig } from "./reply.js";
import { HEARTBEAT_TOKEN } from "./tokens.js";

const webMocks = vi.hoisted(() => ({
  webAuthExists: vi.fn().mockResolvedValue(true),
  getWebAuthAgeMs: vi.fn().mockReturnValue(120_000),
  readWebSelfId: vi.fn().mockReturnValue({ e164: "+1999" }),
}));

vi.mock("../web/session.js", () => webMocks);

async function withTempHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const base = await fs.mkdtemp(join(tmpdir(), "clawdbot-triggers-"));
  const previousHome = process.env.HOME;
  process.env.HOME = base;
  try {
    vi.mocked(runEmbeddedPiAgent).mockClear();
    return await fn(base);
  } finally {
    process.env.HOME = previousHome;
    await fs.rm(base, { recursive: true, force: true });
  }
}

function makeCfg(home: string) {
  return {
    agent: {
      model: "anthropic/claude-opus-4-5",
      workspace: join(home, "clawd"),
    },
    whatsapp: {
      allowFrom: ["*"],
    },
    session: { store: join(home, "sessions.json") },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("trigger handling", () => {
  it("aborts even with timestamp prefix", async () => {
    await withTempHome(async (home) => {
      const res = await getReplyFromConfig(
        {
          Body: "[Dec 5 10:00] stop",
          From: "+1000",
          To: "+2000",
        },
        {},
        makeCfg(home),
      );
      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(text).toBe("⚙️ Agent was aborted.");
      expect(runEmbeddedPiAgent).not.toHaveBeenCalled();
    });
  });

  it("restarts even with prefix/whitespace", async () => {
    await withTempHome(async (home) => {
      const res = await getReplyFromConfig(
        {
          Body: "  [Dec 5] /restart",
          From: "+1001",
          To: "+2000",
        },
        {},
        makeCfg(home),
      );
      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(text?.startsWith("⚙️ Restarting")).toBe(true);
      expect(runEmbeddedPiAgent).not.toHaveBeenCalled();
    });
  });

  it("reports status without invoking the agent", async () => {
    await withTempHome(async (home) => {
      const res = await getReplyFromConfig(
        {
          Body: "/status",
          From: "+1002",
          To: "+2000",
        },
        {},
        makeCfg(home),
      );
      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(text).toContain("Status");
      expect(runEmbeddedPiAgent).not.toHaveBeenCalled();
    });
  });

  it("reports status when /status appears inline", async () => {
    await withTempHome(async (home) => {
      const res = await getReplyFromConfig(
        {
          Body: "please /status now",
          From: "+1002",
          To: "+2000",
        },
        {},
        makeCfg(home),
      );
      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(text).toContain("Status");
      expect(runEmbeddedPiAgent).not.toHaveBeenCalled();
    });
  });

  it("returns help without invoking the agent", async () => {
    await withTempHome(async (home) => {
      const res = await getReplyFromConfig(
        {
          Body: "/help",
          From: "+1002",
          To: "+2000",
        },
        {},
        makeCfg(home),
      );
      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(text).toContain("Help");
      expect(text).toContain("Shortcuts");
      expect(runEmbeddedPiAgent).not.toHaveBeenCalled();
    });
  });

  it("allows owner to set send policy", async () => {
    await withTempHome(async (home) => {
      const cfg = {
        agent: {
          model: "anthropic/claude-opus-4-5",
          workspace: join(home, "clawd"),
        },
        whatsapp: {
          allowFrom: ["+1000"],
        },
        session: { store: join(home, "sessions.json") },
      };

      const res = await getReplyFromConfig(
        {
          Body: "/send off",
          From: "+1000",
          To: "+2000",
          Surface: "whatsapp",
          SenderE164: "+1000",
        },
        {},
        cfg,
      );
      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(text).toContain("Send policy set to off");

      const storeRaw = await fs.readFile(cfg.session.store, "utf-8");
      const store = JSON.parse(storeRaw) as Record<
        string,
        { sendPolicy?: string }
      >;
      expect(store.main?.sendPolicy).toBe("deny");
    });
  });

  it("allows approved sender to toggle elevated mode", async () => {
    await withTempHome(async (home) => {
      const cfg = {
        agent: {
          model: "anthropic/claude-opus-4-5",
          workspace: join(home, "clawd"),
          elevated: {
            allowFrom: { whatsapp: ["+1000"] },
          },
        },
        whatsapp: {
          allowFrom: ["+1000"],
        },
        session: { store: join(home, "sessions.json") },
      };

      const res = await getReplyFromConfig(
        {
          Body: "/elevated on",
          From: "+1000",
          To: "+2000",
          Surface: "whatsapp",
          SenderE164: "+1000",
        },
        {},
        cfg,
      );
      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(text).toContain("Elevated mode enabled");

      const storeRaw = await fs.readFile(cfg.session.store, "utf-8");
      const store = JSON.parse(storeRaw) as Record<
        string,
        { elevatedLevel?: string }
      >;
      expect(store.main?.elevatedLevel).toBe("on");
    });
  });

  it("rejects elevated toggles when disabled", async () => {
    await withTempHome(async (home) => {
      const cfg = {
        agent: {
          model: "anthropic/claude-opus-4-5",
          workspace: join(home, "clawd"),
          elevated: {
            enabled: false,
            allowFrom: { whatsapp: ["+1000"] },
          },
        },
        whatsapp: {
          allowFrom: ["+1000"],
        },
        session: { store: join(home, "sessions.json") },
      };

      const res = await getReplyFromConfig(
        {
          Body: "/elevated on",
          From: "+1000",
          To: "+2000",
          Surface: "whatsapp",
          SenderE164: "+1000",
        },
        {},
        cfg,
      );
      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(text).toBe("elevated is not available right now.");

      const storeRaw = await fs.readFile(cfg.session.store, "utf-8");
      const store = JSON.parse(storeRaw) as Record<
        string,
        { elevatedLevel?: string }
      >;
      expect(store.main?.elevatedLevel).toBeUndefined();
    });
  });

  it("rejects elevated inline directive for unapproved sender", async () => {
    await withTempHome(async (home) => {
      const cfg = {
        agent: {
          model: "anthropic/claude-opus-4-5",
          workspace: join(home, "clawd"),
          elevated: {
            allowFrom: { whatsapp: ["+1000"] },
          },
        },
        whatsapp: {
          allowFrom: ["+1000"],
        },
        session: { store: join(home, "sessions.json") },
      };

      const res = await getReplyFromConfig(
        {
          Body: "please /elevated on now",
          From: "+2000",
          To: "+2000",
          Surface: "whatsapp",
          SenderE164: "+2000",
        },
        {},
        cfg,
      );
      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(text).toBe("elevated is not available right now.");
      expect(runEmbeddedPiAgent).not.toHaveBeenCalled();
    });
  });

  it("falls back to discord dm allowFrom for elevated approval", async () => {
    await withTempHome(async (home) => {
      const cfg = {
        agent: {
          model: "anthropic/claude-opus-4-5",
          workspace: join(home, "clawd"),
        },
        discord: {
          dm: {
            allowFrom: ["steipete"],
          },
        },
        session: { store: join(home, "sessions.json") },
      };

      const res = await getReplyFromConfig(
        {
          Body: "/elevated on",
          From: "discord:123",
          To: "user:123",
          Surface: "discord",
          SenderName: "Peter Steinberger",
          SenderUsername: "steipete",
          SenderTag: "steipete",
        },
        {},
        cfg,
      );
      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(text).toContain("Elevated mode enabled");

      const storeRaw = await fs.readFile(cfg.session.store, "utf-8");
      const store = JSON.parse(storeRaw) as Record<
        string,
        { elevatedLevel?: string }
      >;
      expect(store.main?.elevatedLevel).toBe("on");
    });
  });

  it("treats explicit discord elevated allowlist as override", async () => {
    await withTempHome(async (home) => {
      const cfg = {
        agent: {
          model: "anthropic/claude-opus-4-5",
          workspace: join(home, "clawd"),
          elevated: {
            allowFrom: { discord: [] },
          },
        },
        discord: {
          dm: {
            allowFrom: ["steipete"],
          },
        },
        session: { store: join(home, "sessions.json") },
      };

      const res = await getReplyFromConfig(
        {
          Body: "/elevated on",
          From: "discord:123",
          To: "user:123",
          Surface: "discord",
          SenderName: "steipete",
        },
        {},
        cfg,
      );
      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(text).toBe("elevated is not available right now.");
      expect(runEmbeddedPiAgent).not.toHaveBeenCalled();
    });
  });

  it("returns a context overflow fallback when the embedded agent throws", async () => {
    await withTempHome(async (home) => {
      vi.mocked(runEmbeddedPiAgent).mockRejectedValue(
        new Error("Context window exceeded"),
      );

      const res = await getReplyFromConfig(
        {
          Body: "hello",
          From: "+1002",
          To: "+2000",
        },
        {},
        makeCfg(home),
      );

      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(text).toBe(
        "⚠️ Context overflow - conversation too long. Starting fresh might help!",
      );
      expect(runEmbeddedPiAgent).toHaveBeenCalledOnce();
    });
  });

  it("includes the error cause when the embedded agent throws", async () => {
    await withTempHome(async (home) => {
      vi.mocked(runEmbeddedPiAgent).mockRejectedValue(
        new Error("sandbox is not defined"),
      );

      const res = await getReplyFromConfig(
        {
          Body: "hello",
          From: "+1002",
          To: "+2000",
        },
        {},
        makeCfg(home),
      );

      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(text).toBe(
        "⚠️ Agent failed before reply: sandbox is not defined. Check gateway logs for details.",
      );
      expect(runEmbeddedPiAgent).toHaveBeenCalledOnce();
    });
  });

  it("uses heartbeat model override for heartbeat runs", async () => {
    await withTempHome(async (home) => {
      vi.mocked(runEmbeddedPiAgent).mockResolvedValue({
        payloads: [{ text: "ok" }],
        meta: {
          durationMs: 1,
          agentMeta: { sessionId: "s", provider: "p", model: "m" },
        },
      });

      const cfg = makeCfg(home);
      cfg.agent = {
        ...cfg.agent,
        heartbeat: { model: "anthropic/claude-haiku-4-5-20251001" },
      };

      await getReplyFromConfig(
        {
          Body: "hello",
          From: "+1002",
          To: "+2000",
        },
        { isHeartbeat: true },
        cfg,
      );

      const call = vi.mocked(runEmbeddedPiAgent).mock.calls[0]?.[0];
      expect(call?.provider).toBe("anthropic");
      expect(call?.model).toBe("claude-haiku-4-5-20251001");
    });
  });

  it("suppresses HEARTBEAT_OK replies outside heartbeat runs", async () => {
    await withTempHome(async (home) => {
      vi.mocked(runEmbeddedPiAgent).mockResolvedValue({
        payloads: [{ text: HEARTBEAT_TOKEN }],
        meta: {
          durationMs: 1,
          agentMeta: { sessionId: "s", provider: "p", model: "m" },
        },
      });

      const res = await getReplyFromConfig(
        {
          Body: "hello",
          From: "+1002",
          To: "+2000",
        },
        {},
        makeCfg(home),
      );

      expect(res).toBeUndefined();
      expect(runEmbeddedPiAgent).toHaveBeenCalledOnce();
    });
  });

  it("strips HEARTBEAT_OK at edges outside heartbeat runs", async () => {
    await withTempHome(async (home) => {
      vi.mocked(runEmbeddedPiAgent).mockResolvedValue({
        payloads: [{ text: `${HEARTBEAT_TOKEN} hello` }],
        meta: {
          durationMs: 1,
          agentMeta: { sessionId: "s", provider: "p", model: "m" },
        },
      });

      const res = await getReplyFromConfig(
        {
          Body: "hello",
          From: "+1002",
          To: "+2000",
        },
        {},
        makeCfg(home),
      );

      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(text).toBe("hello");
    });
  });

  it("updates group activation when the owner sends /activation", async () => {
    await withTempHome(async (home) => {
      const cfg = makeCfg(home);
      const res = await getReplyFromConfig(
        {
          Body: "/activation always",
          From: "123@g.us",
          To: "+2000",
          ChatType: "group",
          Surface: "whatsapp",
          SenderE164: "+2000",
        },
        {},
        cfg,
      );
      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(text).toContain("Group activation set to always");
      const store = JSON.parse(
        await fs.readFile(cfg.session.store, "utf-8"),
      ) as Record<string, { groupActivation?: string }>;
      expect(store["whatsapp:group:123@g.us"]?.groupActivation).toBe("always");
      expect(runEmbeddedPiAgent).not.toHaveBeenCalled();
    });
  });

  it("allows /activation from allowFrom in groups", async () => {
    await withTempHome(async (home) => {
      const cfg = makeCfg(home);
      const res = await getReplyFromConfig(
        {
          Body: "/activation mention",
          From: "123@g.us",
          To: "+2000",
          ChatType: "group",
          Surface: "whatsapp",
          SenderE164: "+999",
        },
        {},
        cfg,
      );
      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(text).toBe("⚙️ Group activation set to mention.");
      expect(runEmbeddedPiAgent).not.toHaveBeenCalled();
    });
  });

  it("injects group activation context into the system prompt", async () => {
    await withTempHome(async (home) => {
      vi.mocked(runEmbeddedPiAgent).mockResolvedValue({
        payloads: [{ text: "ok" }],
        meta: {
          durationMs: 1,
          agentMeta: { sessionId: "s", provider: "p", model: "m" },
        },
      });

      const res = await getReplyFromConfig(
        {
          Body: "hello group",
          From: "123@g.us",
          To: "+2000",
          ChatType: "group",
          Surface: "whatsapp",
          SenderE164: "+2000",
          GroupSubject: "Test Group",
          GroupMembers: "Alice (+1), Bob (+2)",
        },
        {},
        {
          agent: {
            model: "anthropic/claude-opus-4-5",
            workspace: join(home, "clawd"),
          },
          whatsapp: {
            allowFrom: ["*"],
            groups: { "*": { requireMention: false } },
          },
          routing: {
            groupChat: {},
          },
          session: { store: join(home, "sessions.json") },
        },
      );

      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(text).toBe("ok");
      expect(runEmbeddedPiAgent).toHaveBeenCalledOnce();
      const extra =
        vi.mocked(runEmbeddedPiAgent).mock.calls[0]?.[0]?.extraSystemPrompt ??
        "";
      expect(extra).toContain("Test Group");
      expect(extra).toContain("Activation: always-on");
    });
  });

  it("runs a greeting prompt for a bare /new", async () => {
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
          Body: "/new",
          From: "+1003",
          To: "+2000",
        },
        {},
        {
          agent: {
            model: "anthropic/claude-opus-4-5",
            workspace: join(home, "clawd"),
          },
          whatsapp: {
            allowFrom: ["*"],
          },
          session: {
            store: join(tmpdir(), `clawdbot-session-test-${Date.now()}.json`),
          },
        },
      );
      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(text).toBe("hello");
      expect(runEmbeddedPiAgent).toHaveBeenCalledOnce();
      const prompt =
        vi.mocked(runEmbeddedPiAgent).mock.calls[0]?.[0]?.prompt ?? "";
      expect(prompt).toContain("A new session was started via /new or /reset");
    });
  });

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
        },
        {},
        {
          agent: {
            model: "anthropic/claude-opus-4-5",
            workspace: join(home, "clawd"),
          },
          whatsapp: {
            allowFrom: ["*"],
          },
          session: {
            store: join(tmpdir(), `clawdbot-session-test-${Date.now()}.json`),
          },
        },
      );
      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(text).toBe("hello");
      expect(runEmbeddedPiAgent).toHaveBeenCalledOnce();
      const prompt =
        vi.mocked(runEmbeddedPiAgent).mock.calls[0]?.[0]?.prompt ?? "";
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
          agent: {
            model: "anthropic/claude-opus-4-5",
            workspace: join(home, "clawd"),
          },
          whatsapp: {
            allowFrom: ["+1999"],
          },
          session: {
            store: join(tmpdir(), `clawdbot-session-test-${Date.now()}.json`),
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
        },
        {},
        {
          agent: {
            model: "anthropic/claude-opus-4-5",
            workspace: join(home, "clawd"),
          },
          whatsapp: {
            allowFrom: ["+1999"],
          },
          session: {
            store: join(tmpdir(), `clawdbot-session-test-${Date.now()}.json`),
          },
        },
      );
      expect(res).toBeUndefined();
      expect(runEmbeddedPiAgent).not.toHaveBeenCalled();
    });
  });

  it("runs /compact as a gated command", async () => {
    await withTempHome(async (home) => {
      const storePath = join(
        tmpdir(),
        `clawdbot-session-test-${Date.now()}.json`,
      );
      vi.mocked(compactEmbeddedPiSession).mockResolvedValue({
        ok: true,
        compacted: true,
        result: {
          summary: "summary",
          firstKeptEntryId: "x",
          tokensBefore: 12000,
        },
      });

      const res = await getReplyFromConfig(
        {
          Body: "/compact focus on decisions",
          From: "+1003",
          To: "+2000",
        },
        {},
        {
          agent: {
            model: "anthropic/claude-opus-4-5",
            workspace: join(home, "clawd"),
          },
          whatsapp: {
            allowFrom: ["*"],
          },
          session: {
            store: storePath,
          },
        },
      );
      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(text?.startsWith("⚙️ Compacted")).toBe(true);
      expect(compactEmbeddedPiSession).toHaveBeenCalledOnce();
      expect(runEmbeddedPiAgent).not.toHaveBeenCalled();
      const store = loadSessionStore(storePath);
      const sessionKey = resolveSessionKey("per-sender", {
        Body: "/compact focus on decisions",
        From: "+1003",
        To: "+2000",
      });
      expect(store[sessionKey]?.compactionCount).toBe(1);
    });
  });

  it("ignores think directives that only appear in the context wrapper", async () => {
    await withTempHome(async (home) => {
      vi.mocked(runEmbeddedPiAgent).mockResolvedValue({
        payloads: [{ text: "ok" }],
        meta: {
          durationMs: 1,
          agentMeta: { sessionId: "s", provider: "p", model: "m" },
        },
      });

      const res = await getReplyFromConfig(
        {
          Body: [
            "[Chat messages since your last reply - for context]",
            "Peter: /thinking high [2025-12-05T21:45:00.000Z]",
            "",
            "[Current message - respond to this]",
            "Give me the status",
          ].join("\n"),
          From: "+1002",
          To: "+2000",
        },
        {},
        makeCfg(home),
      );

      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(text).toBe("ok");
      expect(runEmbeddedPiAgent).toHaveBeenCalledOnce();
      const prompt =
        vi.mocked(runEmbeddedPiAgent).mock.calls[0]?.[0]?.prompt ?? "";
      expect(prompt).toContain("Give me the status");
      expect(prompt).not.toContain("/thinking high");
    });
  });

  it("does not emit directive acks for heartbeats with /think", async () => {
    await withTempHome(async (home) => {
      vi.mocked(runEmbeddedPiAgent).mockResolvedValue({
        payloads: [{ text: "ok" }],
        meta: {
          durationMs: 1,
          agentMeta: { sessionId: "s", provider: "p", model: "m" },
        },
      });

      const res = await getReplyFromConfig(
        {
          Body: "HEARTBEAT /think:high",
          From: "+1003",
          To: "+1003",
        },
        { isHeartbeat: true },
        makeCfg(home),
      );

      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(text).toBe("ok");
      expect(text).not.toMatch(/Thinking level set/i);
      expect(runEmbeddedPiAgent).toHaveBeenCalledOnce();
    });
  });

  it("stages inbound media into the sandbox workspace", async () => {
    await withTempHome(async (home) => {
      const inboundDir = join(home, ".clawdbot", "media", "inbound");
      await fs.mkdir(inboundDir, { recursive: true });
      const mediaPath = join(inboundDir, "photo.jpg");
      await fs.writeFile(mediaPath, "test");

      vi.mocked(runEmbeddedPiAgent).mockResolvedValue({
        payloads: [{ text: "ok" }],
        meta: {
          durationMs: 1,
          agentMeta: { sessionId: "s", provider: "p", model: "m" },
        },
      });

      const cfg = {
        agent: {
          model: "anthropic/claude-opus-4-5",
          workspace: join(home, "clawd"),
          sandbox: {
            mode: "non-main" as const,
            workspaceRoot: join(home, "sandboxes"),
          },
        },
        whatsapp: {
          allowFrom: ["*"],
        },
        session: {
          store: join(home, "sessions.json"),
        },
      };

      const ctx = {
        Body: "hi",
        From: "group:whatsapp:demo",
        To: "+2000",
        ChatType: "group" as const,
        Surface: "whatsapp" as const,
        MediaPath: mediaPath,
        MediaType: "image/jpeg",
        MediaUrl: mediaPath,
      };

      const res = await getReplyFromConfig(ctx, {}, cfg);
      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(text).toBe("ok");
      expect(runEmbeddedPiAgent).toHaveBeenCalledOnce();

      const prompt =
        vi.mocked(runEmbeddedPiAgent).mock.calls[0]?.[0]?.prompt ?? "";
      const stagedPath = `media/inbound/${basename(mediaPath)}`;
      expect(prompt).toContain(stagedPath);
      expect(prompt).not.toContain(mediaPath);

      const sessionKey = resolveSessionKey(
        cfg.session?.scope ?? "per-sender",
        ctx,
        cfg.session?.mainKey,
      );
      const sandbox = await ensureSandboxWorkspaceForSession({
        config: cfg,
        sessionKey,
        workspaceDir: cfg.agent.workspace,
      });
      expect(sandbox).not.toBeNull();
      if (!sandbox) {
        throw new Error("Expected sandbox to be set");
      }
      const stagedFullPath = join(
        sandbox.workspaceDir,
        "media",
        "inbound",
        basename(mediaPath),
      );
      await expect(fs.stat(stagedFullPath)).resolves.toBeTruthy();
    });
  });
});

describe("group intro prompts", () => {
  const groupParticipationNote =
    "Be a good group participant: lurk and follow the conversation, but only chime in when you have something genuinely helpful or relevant to add. Don't feel obligated to respond to every message — quality over quantity. Even when lurking silently, you can use emoji reactions to acknowledge messages, show support, or react to humor — reactions are always appreciated and don't clutter the chat.";
  it("labels Discord groups using the surface metadata", async () => {
    await withTempHome(async (home) => {
      vi.mocked(runEmbeddedPiAgent).mockResolvedValue({
        payloads: [{ text: "ok" }],
        meta: {
          durationMs: 1,
          agentMeta: { sessionId: "s", provider: "p", model: "m" },
        },
      });

      await getReplyFromConfig(
        {
          Body: "status update",
          From: "group:dev",
          To: "+1888",
          ChatType: "group",
          GroupSubject: "Release Squad",
          GroupMembers: "Alice, Bob",
          Surface: "discord",
        },
        {},
        makeCfg(home),
      );

      expect(runEmbeddedPiAgent).toHaveBeenCalledOnce();
      const extraSystemPrompt =
        vi.mocked(runEmbeddedPiAgent).mock.calls.at(-1)?.[0]
          ?.extraSystemPrompt ?? "";
      expect(extraSystemPrompt).toBe(
        `You are replying inside the Discord group "Release Squad". Group members: Alice, Bob. Activation: trigger-only (you are invoked only when explicitly mentioned; recent context may be included). ${groupParticipationNote} Address the specific sender noted in the message context.`,
      );
    });
  });

  it("keeps WhatsApp labeling for WhatsApp group chats", async () => {
    await withTempHome(async (home) => {
      vi.mocked(runEmbeddedPiAgent).mockResolvedValue({
        payloads: [{ text: "ok" }],
        meta: {
          durationMs: 1,
          agentMeta: { sessionId: "s", provider: "p", model: "m" },
        },
      });

      await getReplyFromConfig(
        {
          Body: "ping",
          From: "123@g.us",
          To: "+1999",
          ChatType: "group",
          GroupSubject: "Ops",
          Surface: "whatsapp",
        },
        {},
        makeCfg(home),
      );

      expect(runEmbeddedPiAgent).toHaveBeenCalledOnce();
      const extraSystemPrompt =
        vi.mocked(runEmbeddedPiAgent).mock.calls.at(-1)?.[0]
          ?.extraSystemPrompt ?? "";
      expect(extraSystemPrompt).toBe(
        `You are replying inside the WhatsApp group "Ops". Activation: trigger-only (you are invoked only when explicitly mentioned; recent context may be included). ${groupParticipationNote} Address the specific sender noted in the message context.`,
      );
    });
  });

  it("labels Telegram groups using their own surface", async () => {
    await withTempHome(async (home) => {
      vi.mocked(runEmbeddedPiAgent).mockResolvedValue({
        payloads: [{ text: "ok" }],
        meta: {
          durationMs: 1,
          agentMeta: { sessionId: "s", provider: "p", model: "m" },
        },
      });

      await getReplyFromConfig(
        {
          Body: "ping",
          From: "group:tg",
          To: "+1777",
          ChatType: "group",
          GroupSubject: "Dev Chat",
          Surface: "telegram",
        },
        {},
        makeCfg(home),
      );

      expect(runEmbeddedPiAgent).toHaveBeenCalledOnce();
      const extraSystemPrompt =
        vi.mocked(runEmbeddedPiAgent).mock.calls.at(-1)?.[0]
          ?.extraSystemPrompt ?? "";
      expect(extraSystemPrompt).toBe(
        `You are replying inside the Telegram group "Dev Chat". Activation: trigger-only (you are invoked only when explicitly mentioned; recent context may be included). ${groupParticipationNote} Address the specific sender noted in the message context.`,
      );
    });
  });
});
