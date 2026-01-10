import fs from "node:fs/promises";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { withTempHome as withTempHomeBase } from "../../test/helpers/temp-home.js";
import { loadModelCatalog } from "../agents/model-catalog.js";
import { runEmbeddedPiAgent } from "../agents/pi-embedded.js";
import {
  loadSessionStore,
  resolveSessionKey,
  saveSessionStore,
} from "../config/sessions.js";
import { drainSystemEvents } from "../infra/system-events.js";
import { getReplyFromConfig } from "./reply.js";

const MAIN_SESSION_KEY = "agent:main:main";

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
  return withTempHomeBase(
    async (home) => {
      return await fn(home);
    },
    {
      env: {
        CLAWDBOT_AGENT_DIR: (home) => path.join(home, ".clawdbot", "agent"),
        PI_CODING_AGENT_DIR: (home) => path.join(home, ".clawdbot", "agent"),
      },
      prefix: "clawdbot-reply-",
    },
  );
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

  it("keeps reserved command aliases from matching after trimming", async () => {
    await withTempHome(async (home) => {
      vi.mocked(runEmbeddedPiAgent).mockReset();

      const res = await getReplyFromConfig(
        {
          Body: "/help",
          From: "+1222",
          To: "+1222",
        },
        {},
        {
          agents: {
            defaults: {
              model: "anthropic/claude-opus-4-5",
              workspace: path.join(home, "clawd"),
              models: {
                "anthropic/claude-opus-4-5": { alias: " help " },
              },
            },
          },
          whatsapp: { allowFrom: ["*"] },
          session: { store: path.join(home, "sessions.json") },
        },
      );

      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(text).toContain("Help");
      expect(runEmbeddedPiAgent).not.toHaveBeenCalled();
    });
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
          agents: {
            defaults: {
              model: "anthropic/claude-opus-4-5",
              workspace: path.join(home, "clawd"),
            },
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

  it("shows current queue settings when /queue has no arguments", async () => {
    await withTempHome(async (home) => {
      vi.mocked(runEmbeddedPiAgent).mockReset();

      const res = await getReplyFromConfig(
        {
          Body: "/queue",
          From: "+1222",
          To: "+1222",
          Provider: "whatsapp",
        },
        {},
        {
          agents: {
            defaults: {
              model: "anthropic/claude-opus-4-5",
              workspace: path.join(home, "clawd"),
            },
          },
          messages: {
            queue: {
              mode: "collect",
              debounceMs: 1500,
              cap: 9,
              drop: "summarize",
            },
          },
          whatsapp: { allowFrom: ["*"] },
          session: { store: path.join(home, "sessions.json") },
        },
      );

      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(text).toContain(
        "Current queue settings: mode=collect, debounce=1500ms, cap=9, drop=summarize.",
      );
      expect(text).toContain(
        "Options: modes steer, followup, collect, steer+backlog, interrupt; debounce:<ms|s|m>, cap:<n>, drop:old|new|summarize.",
      );
      expect(runEmbeddedPiAgent).not.toHaveBeenCalled();
    });
  });

  it("shows current think level when /think has no argument", async () => {
    await withTempHome(async (home) => {
      vi.mocked(runEmbeddedPiAgent).mockReset();

      const res = await getReplyFromConfig(
        { Body: "/think", From: "+1222", To: "+1222" },
        {},
        {
          agents: {
            defaults: {
              model: "anthropic/claude-opus-4-5",
              workspace: path.join(home, "clawd"),
              thinkingDefault: "high",
            },
          },
          session: { store: path.join(home, "sessions.json") },
        },
      );

      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(text).toContain("Current thinking level: high");
      expect(text).toContain("Options: off, minimal, low, medium, high.");
      expect(runEmbeddedPiAgent).not.toHaveBeenCalled();
    });
  });

  it("shows off when /think has no argument and no default set", async () => {
    await withTempHome(async (home) => {
      vi.mocked(runEmbeddedPiAgent).mockReset();

      const res = await getReplyFromConfig(
        { Body: "/think", From: "+1222", To: "+1222" },
        {},
        {
          agents: {
            defaults: {
              model: "anthropic/claude-opus-4-5",
              workspace: path.join(home, "clawd"),
            },
          },
          session: { store: path.join(home, "sessions.json") },
        },
      );

      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(text).toContain("Current thinking level: off");
      expect(text).toContain("Options: off, minimal, low, medium, high.");
      expect(runEmbeddedPiAgent).not.toHaveBeenCalled();
    });
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
          agents: {
            defaults: {
              model: "anthropic/claude-opus-4-5",
              workspace: path.join(home, "clawd"),
            },
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

  it("strips reply tags with whitespace and maps reply_to_current to MessageSid", async () => {
    await withTempHome(async (home) => {
      vi.mocked(runEmbeddedPiAgent).mockResolvedValue({
        payloads: [{ text: "hello [[ reply_to_current ]]" }],
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
          agents: {
            defaults: {
              model: "anthropic/claude-opus-4-5",
              workspace: path.join(home, "clawd"),
            },
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
          agents: {
            defaults: {
              model: "anthropic/claude-opus-4-5",
              workspace: path.join(home, "clawd"),
            },
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
          agents: {
            defaults: {
              model: "anthropic/claude-opus-4-5",
              workspace: path.join(home, "clawd"),
            },
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
          agents: {
            defaults: {
              model: "anthropic/claude-opus-4-5",
              workspace: path.join(home, "clawd"),
            },
          },
          session: { store: path.join(home, "sessions.json") },
        },
      );

      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(text).toMatch(/^⚙️ Verbose logging enabled\./);
      expect(runEmbeddedPiAgent).not.toHaveBeenCalled();
    });
  });

  it("persists verbose off when directive is standalone", async () => {
    await withTempHome(async (home) => {
      vi.mocked(runEmbeddedPiAgent).mockReset();
      const storePath = path.join(home, "sessions.json");

      const res = await getReplyFromConfig(
        { Body: "/verbose off", From: "+1222", To: "+1222" },
        {},
        {
          agents: {
            defaults: {
              model: "anthropic/claude-opus-4-5",
              workspace: path.join(home, "clawd"),
            },
          },
          session: { store: storePath },
        },
      );

      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(text).toMatch(/Verbose logging disabled\./);
      const store = loadSessionStore(storePath);
      const entry = Object.values(store)[0];
      expect(entry?.verboseLevel).toBe("off");
      expect(runEmbeddedPiAgent).not.toHaveBeenCalled();
    });
  });

  it("shows current think level when /think has no argument", async () => {
    await withTempHome(async (home) => {
      vi.mocked(runEmbeddedPiAgent).mockReset();

      const res = await getReplyFromConfig(
        { Body: "/think", From: "+1222", To: "+1222" },
        {},
        {
          agents: {
            defaults: {
              model: "anthropic/claude-opus-4-5",
              workspace: path.join(home, "clawd"),
              thinkingDefault: "high",
            },
          },
          session: { store: path.join(home, "sessions.json") },
        },
      );

      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(text).toContain("Current thinking level: high");
      expect(text).toContain("Options: off, minimal, low, medium, high.");
      expect(runEmbeddedPiAgent).not.toHaveBeenCalled();
    });
  });

  it("shows off when /think has no argument and no default set", async () => {
    await withTempHome(async (home) => {
      vi.mocked(runEmbeddedPiAgent).mockReset();

      const res = await getReplyFromConfig(
        { Body: "/think", From: "+1222", To: "+1222" },
        {},
        {
          agents: {
            defaults: {
              model: "anthropic/claude-opus-4-5",
              workspace: path.join(home, "clawd"),
            },
          },
          session: { store: path.join(home, "sessions.json") },
        },
      );

      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(text).toContain("Current thinking level: off");
      expect(text).toContain("Options: off, minimal, low, medium, high.");
      expect(runEmbeddedPiAgent).not.toHaveBeenCalled();
    });
  });

  it("shows current verbose level when /verbose has no argument", async () => {
    await withTempHome(async (home) => {
      vi.mocked(runEmbeddedPiAgent).mockReset();

      const res = await getReplyFromConfig(
        { Body: "/verbose", From: "+1222", To: "+1222" },
        {},
        {
          agents: {
            defaults: {
              model: "anthropic/claude-opus-4-5",
              workspace: path.join(home, "clawd"),
              verboseDefault: "on",
            },
          },
          session: { store: path.join(home, "sessions.json") },
        },
      );

      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(text).toContain("Current verbose level: on");
      expect(text).toContain("Options: on, off.");
      expect(runEmbeddedPiAgent).not.toHaveBeenCalled();
    });
  });

  it("shows current reasoning level when /reasoning has no argument", async () => {
    await withTempHome(async (home) => {
      vi.mocked(runEmbeddedPiAgent).mockReset();

      const res = await getReplyFromConfig(
        { Body: "/reasoning", From: "+1222", To: "+1222" },
        {},
        {
          agents: {
            defaults: {
              model: "anthropic/claude-opus-4-5",
              workspace: path.join(home, "clawd"),
            },
          },
          session: { store: path.join(home, "sessions.json") },
        },
      );

      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(text).toContain("Current reasoning level: off");
      expect(text).toContain("Options: on, off, stream.");
      expect(runEmbeddedPiAgent).not.toHaveBeenCalled();
    });
  });

  it("shows current elevated level when /elevated has no argument", async () => {
    await withTempHome(async (home) => {
      vi.mocked(runEmbeddedPiAgent).mockReset();

      const res = await getReplyFromConfig(
        {
          Body: "/elevated",
          From: "+1222",
          To: "+1222",
          Provider: "whatsapp",
          SenderE164: "+1222",
        },
        {},
        {
          agents: {
            defaults: {
              model: "anthropic/claude-opus-4-5",
              workspace: path.join(home, "clawd"),
              elevatedDefault: "on",
            },
          },
          tools: {
            elevated: {
              allowFrom: { whatsapp: ["+1222"] },
            },
          },
          whatsapp: { allowFrom: ["+1222"] },
          session: { store: path.join(home, "sessions.json") },
        },
      );

      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(text).toContain("Current elevated level: on");
      expect(text).toContain("Options: on, off.");
      expect(runEmbeddedPiAgent).not.toHaveBeenCalled();
    });
  });

  it("persists elevated off and reflects it in /status (even when default is on)", async () => {
    await withTempHome(async (home) => {
      vi.mocked(runEmbeddedPiAgent).mockReset();
      const storePath = path.join(home, "sessions.json");

      const res = await getReplyFromConfig(
        {
          Body: "/elevated off\n/status",
          From: "+1222",
          To: "+1222",
          Provider: "whatsapp",
          SenderE164: "+1222",
        },
        {},
        {
          agents: {
            defaults: {
              model: "anthropic/claude-opus-4-5",
              workspace: path.join(home, "clawd"),
              elevatedDefault: "on",
            },
          },
          tools: {
            elevated: {
              allowFrom: { whatsapp: ["+1222"] },
            },
          },
          whatsapp: { allowFrom: ["+1222"] },
          session: { store: storePath },
        },
      );

      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(text).toContain("Elevated mode disabled.");
      const optionsLine = text
        ?.split("\n")
        .find((line) => line.trim().startsWith("⚙️"));
      expect(optionsLine).toBeTruthy();
      expect(optionsLine).not.toContain("elevated");

      const store = loadSessionStore(storePath);
      expect(store["agent:main:main"]?.elevatedLevel).toBe("off");
      expect(runEmbeddedPiAgent).not.toHaveBeenCalled();
    });
  });

  it("strips inline elevated directives from the user text (does not persist session override)", async () => {
    await withTempHome(async (home) => {
      vi.mocked(runEmbeddedPiAgent).mockResolvedValue({
        payloads: [{ text: "ok" }],
        meta: {
          durationMs: 1,
          agentMeta: { sessionId: "s", provider: "p", model: "m" },
        },
      });
      const storePath = path.join(home, "sessions.json");

      await getReplyFromConfig(
        {
          Body: "hello there /elevated off",
          From: "+1222",
          To: "+1222",
          Provider: "whatsapp",
          SenderE164: "+1222",
        },
        {},
        {
          agents: {
            defaults: {
              model: "anthropic/claude-opus-4-5",
              workspace: path.join(home, "clawd"),
              elevatedDefault: "on",
            },
          },
          tools: {
            elevated: {
              allowFrom: { whatsapp: ["+1222"] },
            },
          },
          whatsapp: { allowFrom: ["+1222"] },
          session: { store: storePath },
        },
      );

      const store = loadSessionStore(storePath);
      expect(store["agent:main:main"]?.elevatedLevel).toBeUndefined();

      const calls = vi.mocked(runEmbeddedPiAgent).mock.calls;
      expect(calls.length).toBeGreaterThan(0);
      const call = calls[0]?.[0];
      expect(call?.prompt).toContain("hello there");
      expect(call?.prompt).not.toContain("/elevated");
    });
  });

  it("shows current elevated level as off after toggling it off", async () => {
    await withTempHome(async (home) => {
      vi.mocked(runEmbeddedPiAgent).mockReset();
      const storePath = path.join(home, "sessions.json");

      await getReplyFromConfig(
        {
          Body: "/elevated off",
          From: "+1222",
          To: "+1222",
          Provider: "whatsapp",
          SenderE164: "+1222",
        },
        {},
        {
          agents: {
            defaults: {
              model: "anthropic/claude-opus-4-5",
              workspace: path.join(home, "clawd"),
              elevatedDefault: "on",
            },
          },
          tools: {
            elevated: {
              allowFrom: { whatsapp: ["+1222"] },
            },
          },
          whatsapp: { allowFrom: ["+1222"] },
          session: { store: storePath },
        },
      );

      const res = await getReplyFromConfig(
        {
          Body: "/elevated",
          From: "+1222",
          To: "+1222",
          Provider: "whatsapp",
          SenderE164: "+1222",
        },
        {},
        {
          agents: {
            defaults: {
              model: "anthropic/claude-opus-4-5",
              workspace: path.join(home, "clawd"),
              elevatedDefault: "on",
            },
          },
          tools: {
            elevated: {
              allowFrom: { whatsapp: ["+1222"] },
            },
          },
          whatsapp: { allowFrom: ["+1222"] },
          session: { store: storePath },
        },
      );

      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(text).toContain("Current elevated level: off");
      expect(runEmbeddedPiAgent).not.toHaveBeenCalled();
    });
  });

  it("can toggle elevated off then back on (status reflects on)", async () => {
    await withTempHome(async (home) => {
      vi.mocked(runEmbeddedPiAgent).mockReset();
      const storePath = path.join(home, "sessions.json");

      const cfg = {
        agents: {
          defaults: {
            model: "anthropic/claude-opus-4-5",
            workspace: path.join(home, "clawd"),
            elevatedDefault: "on",
          },
        },
        tools: {
          elevated: {
            allowFrom: { whatsapp: ["+1222"] },
          },
        },
        whatsapp: { allowFrom: ["+1222"] },
        session: { store: storePath },
      } as const;

      await getReplyFromConfig(
        {
          Body: "/elevated off",
          From: "+1222",
          To: "+1222",
          Provider: "whatsapp",
          SenderE164: "+1222",
        },
        {},
        cfg,
      );
      await getReplyFromConfig(
        {
          Body: "/elevated on",
          From: "+1222",
          To: "+1222",
          Provider: "whatsapp",
          SenderE164: "+1222",
        },
        {},
        cfg,
      );

      const res = await getReplyFromConfig(
        {
          Body: "/status",
          From: "+1222",
          To: "+1222",
          Provider: "whatsapp",
          SenderE164: "+1222",
        },
        {},
        cfg,
      );

      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      const optionsLine = text
        ?.split("\n")
        .find((line) => line.trim().startsWith("⚙️"));
      expect(optionsLine).toBeTruthy();
      expect(optionsLine).toContain("elevated");

      const store = loadSessionStore(storePath);
      expect(store["agent:main:main"]?.elevatedLevel).toBe("on");
      expect(runEmbeddedPiAgent).not.toHaveBeenCalled();
    });
  });

  it("rejects per-agent elevated when disabled", async () => {
    await withTempHome(async (home) => {
      vi.mocked(runEmbeddedPiAgent).mockReset();

      const res = await getReplyFromConfig(
        {
          Body: "/elevated on",
          From: "+1222",
          To: "+1222",
          Provider: "whatsapp",
          SenderE164: "+1222",
          SessionKey: "agent:restricted:main",
        },
        {},
        {
          agents: {
            defaults: {
              model: "anthropic/claude-opus-4-5",
              workspace: path.join(home, "clawd"),
            },
            list: [
              {
                id: "restricted",
                tools: {
                  elevated: { enabled: false },
                },
              },
            ],
          },
          tools: {
            elevated: {
              allowFrom: { whatsapp: ["+1222"] },
            },
          },
          whatsapp: { allowFrom: ["+1222"] },
          session: { store: path.join(home, "sessions.json") },
        },
      );

      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(text).toContain("agents.list[].tools.elevated.enabled");
      expect(runEmbeddedPiAgent).not.toHaveBeenCalled();
    });
  });

  it("requires per-agent allowlist in addition to global", async () => {
    await withTempHome(async (home) => {
      vi.mocked(runEmbeddedPiAgent).mockReset();

      const res = await getReplyFromConfig(
        {
          Body: "/elevated on",
          From: "+1222",
          To: "+1222",
          Provider: "whatsapp",
          SenderE164: "+1222",
          SessionKey: "agent:work:main",
        },
        {},
        {
          agents: {
            defaults: {
              model: "anthropic/claude-opus-4-5",
              workspace: path.join(home, "clawd"),
            },
            list: [
              {
                id: "work",
                tools: {
                  elevated: {
                    allowFrom: { whatsapp: ["+1333"] },
                  },
                },
              },
            ],
          },
          tools: {
            elevated: {
              allowFrom: { whatsapp: ["+1222", "+1333"] },
            },
          },
          whatsapp: { allowFrom: ["+1222", "+1333"] },
          session: { store: path.join(home, "sessions.json") },
        },
      );

      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(text).toContain("agents.list[].tools.elevated.allowFrom.whatsapp");
      expect(runEmbeddedPiAgent).not.toHaveBeenCalled();
    });
  });

  it("allows elevated when both global and per-agent allowlists match", async () => {
    await withTempHome(async (home) => {
      vi.mocked(runEmbeddedPiAgent).mockReset();

      const res = await getReplyFromConfig(
        {
          Body: "/elevated on",
          From: "+1333",
          To: "+1333",
          Provider: "whatsapp",
          SenderE164: "+1333",
          SessionKey: "agent:work:main",
        },
        {},
        {
          agents: {
            defaults: {
              model: "anthropic/claude-opus-4-5",
              workspace: path.join(home, "clawd"),
            },
            list: [
              {
                id: "work",
                tools: {
                  elevated: {
                    allowFrom: { whatsapp: ["+1333"] },
                  },
                },
              },
            ],
          },
          tools: {
            elevated: {
              allowFrom: { whatsapp: ["+1222", "+1333"] },
            },
          },
          whatsapp: { allowFrom: ["+1222", "+1333"] },
          session: { store: path.join(home, "sessions.json") },
        },
      );

      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(text).toContain("Elevated mode enabled");
      expect(runEmbeddedPiAgent).not.toHaveBeenCalled();
    });
  });

  it("warns when elevated is used in direct runtime", async () => {
    await withTempHome(async (home) => {
      vi.mocked(runEmbeddedPiAgent).mockReset();

      const res = await getReplyFromConfig(
        {
          Body: "/elevated off",
          From: "+1222",
          To: "+1222",
          Provider: "whatsapp",
          SenderE164: "+1222",
        },
        {},
        {
          agents: {
            defaults: {
              model: "anthropic/claude-opus-4-5",
              workspace: path.join(home, "clawd"),
              sandbox: { mode: "off" },
            },
          },
          tools: {
            elevated: {
              allowFrom: { whatsapp: ["+1222"] },
            },
          },
          whatsapp: { allowFrom: ["+1222"] },
          session: { store: path.join(home, "sessions.json") },
        },
      );

      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(text).toContain("Elevated mode disabled.");
      expect(text).toContain("Runtime is direct; sandboxing does not apply.");
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
          Provider: "whatsapp",
          SenderE164: "+1222",
        },
        {},
        {
          agents: {
            defaults: {
              model: "anthropic/claude-opus-4-5",
              workspace: path.join(home, "clawd"),
            },
          },
          tools: {
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

  it("handles multiple directives in a single message", async () => {
    await withTempHome(async (home) => {
      vi.mocked(runEmbeddedPiAgent).mockReset();

      const res = await getReplyFromConfig(
        {
          Body: "/elevated off\n/verbose on",
          From: "+1222",
          To: "+1222",
          Provider: "whatsapp",
          SenderE164: "+1222",
        },
        {},
        {
          agents: {
            defaults: {
              model: "anthropic/claude-opus-4-5",
              workspace: path.join(home, "clawd"),
            },
          },
          tools: {
            elevated: {
              allowFrom: { whatsapp: ["+1222"] },
            },
          },
          whatsapp: { allowFrom: ["+1222"] },
          session: { store: path.join(home, "sessions.json") },
        },
      );

      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(text).toContain("Elevated mode disabled.");
      expect(text).toContain("Verbose logging enabled.");
      expect(runEmbeddedPiAgent).not.toHaveBeenCalled();
    });
  });

  it("returns status alongside directive-only acks", async () => {
    await withTempHome(async (home) => {
      vi.mocked(runEmbeddedPiAgent).mockReset();
      const storePath = path.join(home, "sessions.json");

      const res = await getReplyFromConfig(
        {
          Body: "/elevated off\n/status",
          From: "+1222",
          To: "+1222",
          Provider: "whatsapp",
          SenderE164: "+1222",
        },
        {},
        {
          agents: {
            defaults: {
              model: "anthropic/claude-opus-4-5",
              workspace: path.join(home, "clawd"),
            },
          },
          tools: {
            elevated: {
              allowFrom: { whatsapp: ["+1222"] },
            },
          },
          whatsapp: { allowFrom: ["+1222"] },
          session: { store: storePath },
        },
      );

      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(text).toContain("Elevated mode disabled.");
      expect(text).toContain("Session: agent:main:main");
      const optionsLine = text
        ?.split("\n")
        .find((line) => line.trim().startsWith("⚙️"));
      expect(optionsLine).toBeTruthy();
      expect(optionsLine).not.toContain("elevated");

      const store = loadSessionStore(storePath);
      expect(store["agent:main:main"]?.elevatedLevel).toBe("off");
      expect(runEmbeddedPiAgent).not.toHaveBeenCalled();
    });
  });

  it("shows elevated off in status when per-agent elevated is disabled", async () => {
    await withTempHome(async (home) => {
      vi.mocked(runEmbeddedPiAgent).mockReset();

      const res = await getReplyFromConfig(
        {
          Body: "/status",
          From: "+1222",
          To: "+1222",
          Provider: "whatsapp",
          SenderE164: "+1222",
          SessionKey: "agent:restricted:main",
        },
        {},
        {
          agents: {
            defaults: {
              model: "anthropic/claude-opus-4-5",
              workspace: path.join(home, "clawd"),
            },
            list: [
              {
                id: "restricted",
                tools: {
                  elevated: { enabled: false },
                },
              },
            ],
          },
          tools: {
            elevated: {
              allowFrom: { whatsapp: ["+1222"] },
            },
          },
          whatsapp: { allowFrom: ["+1222"] },
          session: { store: path.join(home, "sessions.json") },
        },
      );

      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(text).not.toContain("elevated");
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
          agents: {
            defaults: {
              model: "anthropic/claude-opus-4-5",
              workspace: path.join(home, "clawd"),
            },
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
          agents: {
            defaults: {
              model: "anthropic/claude-opus-4-5",
              workspace: path.join(home, "clawd"),
            },
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
          agents: {
            defaults: {
              model: "anthropic/claude-opus-4-5",
              workspace: path.join(home, "clawd"),
            },
          },
          whatsapp: { allowFrom: ["*"] },
          session: { store: storePath },
        },
      );

      const res = await getReplyFromConfig(
        { Body: "/queue reset", From: "+1222", To: "+1222" },
        {},
        {
          agents: {
            defaults: {
              model: "anthropic/claude-opus-4-5",
              workspace: path.join(home, "clawd"),
            },
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
          agents: {
            defaults: {
              model: "anthropic/claude-opus-4-5",
              workspace: path.join(home, "clawd"),
            },
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
        { Body: "/verbose on", From: ctx.From, To: ctx.To },
        {},
        {
          agents: {
            defaults: {
              model: "anthropic/claude-opus-4-5",
              workspace: path.join(home, "clawd"),
            },
          },
          whatsapp: {
            allowFrom: ["*"],
          },
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

  it("lists allowlisted models on /model status", async () => {
    await withTempHome(async (home) => {
      vi.mocked(runEmbeddedPiAgent).mockReset();
      const storePath = path.join(home, "sessions.json");

      const res = await getReplyFromConfig(
        { Body: "/model status", From: "+1222", To: "+1222" },
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

  it("lists allowlisted models on /model list", async () => {
    await withTempHome(async (home) => {
      vi.mocked(runEmbeddedPiAgent).mockReset();
      const storePath = path.join(home, "sessions.json");

      const res = await getReplyFromConfig(
        { Body: "/model list", From: "+1222", To: "+1222" },
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
      expect(text).toContain("auth:");
      expect(runEmbeddedPiAgent).not.toHaveBeenCalled();
    });
  });

  it("falls back to configured models when catalog is unavailable", async () => {
    await withTempHome(async (home) => {
      vi.mocked(runEmbeddedPiAgent).mockReset();
      vi.mocked(loadModelCatalog).mockResolvedValueOnce([]);
      const storePath = path.join(home, "sessions.json");

      const res = await getReplyFromConfig(
        { Body: "/model", From: "+1222", To: "+1222" },
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
      expect(text).toContain("Model catalog unavailable");
      expect(text).toContain("anthropic/claude-opus-4-5");
      expect(text).toContain("openai/gpt-4.1-mini");
      expect(runEmbeddedPiAgent).not.toHaveBeenCalled();
    });
  });

  it("does not repeat missing auth labels on /model list", async () => {
    await withTempHome(async (home) => {
      vi.mocked(runEmbeddedPiAgent).mockReset();
      const storePath = path.join(home, "sessions.json");

      const res = await getReplyFromConfig(
        { Body: "/model list", From: "+1222", To: "+1222" },
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
      expect(text).toContain("auth:");
      expect(text).not.toContain("missing (missing)");
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
      expect(text).toContain("Model set to openai/gpt-4.1-mini");
      const store = loadSessionStore(storePath);
      const entry = store["agent:main:main"];
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

      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(text).toContain("Model set to Opus");
      expect(text).toContain("anthropic/claude-opus-4-5");
      const store = loadSessionStore(storePath);
      const entry = store["agent:main:main"];
      expect(entry.modelOverride).toBe("claude-opus-4-5");
      expect(entry.providerOverride).toBe("anthropic");
      expect(runEmbeddedPiAgent).not.toHaveBeenCalled();
    });
  });

  it("stores auth profile overrides on /model directive", async () => {
    await withTempHome(async (home) => {
      vi.mocked(runEmbeddedPiAgent).mockReset();
      const storePath = path.join(home, "sessions.json");
      const authDir = path.join(home, ".clawdbot", "agents", "main", "agent");
      await fs.mkdir(authDir, { recursive: true, mode: 0o700 });
      await fs.writeFile(
        path.join(authDir, "auth-profiles.json"),
        JSON.stringify(
          {
            version: 1,
            profiles: {
              "anthropic:work": {
                type: "api_key",
                provider: "anthropic",
                key: "sk-test-1234567890",
              },
            },
          },
          null,
          2,
        ),
      );

      const res = await getReplyFromConfig(
        { Body: "/model Opus@anthropic:work", From: "+1222", To: "+1222" },
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

      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(text).toContain("Auth profile set to anthropic:work");
      const store = loadSessionStore(storePath);
      const entry = store["agent:main:main"];
      expect(entry.authProfileOverride).toBe("anthropic:work");
      expect(runEmbeddedPiAgent).not.toHaveBeenCalled();
    });
  });

  it("queues a system event when switching models", async () => {
    await withTempHome(async (home) => {
      drainSystemEvents(MAIN_SESSION_KEY);
      vi.mocked(runEmbeddedPiAgent).mockReset();
      const storePath = path.join(home, "sessions.json");

      await getReplyFromConfig(
        { Body: "/model Opus", From: "+1222", To: "+1222" },
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

      const events = drainSystemEvents(MAIN_SESSION_KEY);
      expect(events).toContain(
        "Model switched to Opus (anthropic/claude-opus-4-5).",
      );
      expect(runEmbeddedPiAgent).not.toHaveBeenCalled();
    });
  });

  it("ignores inline /model and uses the default model", async () => {
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
      expect(call?.provider).toBe("anthropic");
      expect(call?.model).toBe("claude-opus-4-5");
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
          agents: {
            defaults: {
              model: "anthropic/claude-opus-4-5",
              workspace: path.join(home, "clawd"),
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
          Provider: "whatsapp",
          SenderE164: "+1004",
        },
        {},
        {
          agents: {
            defaults: {
              model: "anthropic/claude-opus-4-5",
              workspace: path.join(home, "clawd"),
            },
          },
          tools: {
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
