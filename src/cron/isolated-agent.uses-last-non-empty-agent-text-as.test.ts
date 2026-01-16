import fs from "node:fs/promises";
import path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { withTempHome as withTempHomeBase } from "../../test/helpers/temp-home.js";
import type { CliDeps } from "../cli/deps.js";
import type { ClawdbotConfig } from "../config/config.js";
import type { CronJob } from "./types.js";

vi.mock("../agents/pi-embedded.js", () => ({
  abortEmbeddedPiRun: vi.fn().mockReturnValue(false),
  runEmbeddedPiAgent: vi.fn(),
  resolveEmbeddedSessionLane: (key: string) => `session:${key.trim() || "main"}`,
}));
vi.mock("../agents/model-catalog.js", () => ({
  loadModelCatalog: vi.fn(),
}));

import { loadModelCatalog } from "../agents/model-catalog.js";
import { runEmbeddedPiAgent } from "../agents/pi-embedded.js";
import { runCronIsolatedAgentTurn } from "./isolated-agent.js";

async function withTempHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  return withTempHomeBase(fn, { prefix: "clawdbot-cron-" });
}

async function writeSessionStore(home: string) {
  const dir = path.join(home, ".clawdbot", "sessions");
  await fs.mkdir(dir, { recursive: true });
  const storePath = path.join(dir, "sessions.json");
  await fs.writeFile(
    storePath,
    JSON.stringify(
      {
        "agent:main:main": {
          sessionId: "main-session",
          updatedAt: Date.now(),
          lastProvider: "webchat",
          lastTo: "",
        },
      },
      null,
      2,
    ),
    "utf-8",
  );
  return storePath;
}

async function readSessionEntry(storePath: string, key: string) {
  const raw = await fs.readFile(storePath, "utf-8");
  const store = JSON.parse(raw) as Record<string, { sessionId?: string }>;
  return store[key];
}

function makeCfg(
  home: string,
  storePath: string,
  overrides: Partial<ClawdbotConfig> = {},
): ClawdbotConfig {
  const base: ClawdbotConfig = {
    agents: {
      defaults: {
        model: "anthropic/claude-opus-4-5",
        workspace: path.join(home, "clawd"),
      },
    },
    session: { store: storePath, mainKey: "main" },
  } as ClawdbotConfig;
  return { ...base, ...overrides };
}

function makeJob(payload: CronJob["payload"]): CronJob {
  const now = Date.now();
  return {
    id: "job-1",
    enabled: true,
    createdAtMs: now,
    updatedAtMs: now,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload,
    state: {},
    isolation: { postToMainPrefix: "Cron" },
  };
}

describe("runCronIsolatedAgentTurn", () => {
  beforeEach(() => {
    vi.mocked(runEmbeddedPiAgent).mockReset();
    vi.mocked(loadModelCatalog).mockResolvedValue([]);
  });

  it("uses last non-empty agent text as summary", async () => {
    await withTempHome(async (home) => {
      const storePath = await writeSessionStore(home);
      const deps: CliDeps = {
        sendMessageWhatsApp: vi.fn(),
        sendMessageTelegram: vi.fn(),
        sendMessageDiscord: vi.fn(),
        sendMessageSignal: vi.fn(),
        sendMessageIMessage: vi.fn(),
      };
      vi.mocked(runEmbeddedPiAgent).mockResolvedValue({
        payloads: [{ text: "first" }, { text: " " }, { text: " last " }],
        meta: {
          durationMs: 5,
          agentMeta: { sessionId: "s", provider: "p", model: "m" },
        },
      });

      const res = await runCronIsolatedAgentTurn({
        cfg: makeCfg(home, storePath),
        deps,
        job: makeJob({ kind: "agentTurn", message: "do it", deliver: false }),
        message: "do it",
        sessionKey: "cron:job-1",
        lane: "cron",
      });

      expect(res.status).toBe("ok");
      expect(res.summary).toBe("last");
    });
  });

  it("uses agentId for workspace, session key, and store paths", async () => {
    await withTempHome(async (home) => {
      const deps: CliDeps = {
        sendMessageWhatsApp: vi.fn(),
        sendMessageTelegram: vi.fn(),
        sendMessageDiscord: vi.fn(),
        sendMessageSignal: vi.fn(),
        sendMessageIMessage: vi.fn(),
      };
      const opsWorkspace = path.join(home, "ops-workspace");
      vi.mocked(runEmbeddedPiAgent).mockResolvedValue({
        payloads: [{ text: "ok" }],
        meta: {
          durationMs: 5,
          agentMeta: { sessionId: "s", provider: "p", model: "m" },
        },
      });

      const cfg = makeCfg(
        home,
        path.join(home, ".clawdbot", "agents", "{agentId}", "sessions", "sessions.json"),
        {
          agents: {
            defaults: { workspace: path.join(home, "default-workspace") },
            list: [
              { id: "main", default: true },
              { id: "ops", workspace: opsWorkspace },
            ],
          },
        },
      );

      const res = await runCronIsolatedAgentTurn({
        cfg,
        deps,
        job: {
          ...makeJob({
            kind: "agentTurn",
            message: "do it",
            deliver: false,
            channel: "last",
          }),
          agentId: "ops",
        },
        message: "do it",
        sessionKey: "cron:job-ops",
        agentId: "ops",
        lane: "cron",
      });

      expect(res.status).toBe("ok");
      const call = vi.mocked(runEmbeddedPiAgent).mock.calls.at(-1)?.[0] as {
        sessionKey?: string;
        workspaceDir?: string;
        sessionFile?: string;
      };
      expect(call?.sessionKey).toBe("agent:ops:cron:job-ops");
      expect(call?.workspaceDir).toBe(opsWorkspace);
      expect(call?.sessionFile).toContain(path.join("agents", "ops"));
    });
  });

  it("uses model override when provided", async () => {
    await withTempHome(async (home) => {
      const storePath = await writeSessionStore(home);
      const deps: CliDeps = {
        sendMessageWhatsApp: vi.fn(),
        sendMessageTelegram: vi.fn(),
        sendMessageDiscord: vi.fn(),
        sendMessageSignal: vi.fn(),
        sendMessageIMessage: vi.fn(),
      };
      vi.mocked(runEmbeddedPiAgent).mockResolvedValue({
        payloads: [{ text: "ok" }],
        meta: {
          durationMs: 5,
          agentMeta: { sessionId: "s", provider: "p", model: "m" },
        },
      });

      const res = await runCronIsolatedAgentTurn({
        cfg: makeCfg(home, storePath),
        deps,
        job: makeJob({
          kind: "agentTurn",
          message: "do it",
          model: "openai/gpt-4.1-mini",
        }),
        message: "do it",
        sessionKey: "cron:job-1",
        lane: "cron",
      });

      expect(res.status).toBe("ok");
      const call = vi.mocked(runEmbeddedPiAgent).mock.calls[0]?.[0] as {
        provider?: string;
        model?: string;
      };
      expect(call?.provider).toBe("openai");
      expect(call?.model).toBe("gpt-4.1-mini");
    });
  });

  it("uses hooks.gmail.model for Gmail hook sessions", async () => {
    await withTempHome(async (home) => {
      const storePath = await writeSessionStore(home);
      const deps: CliDeps = {
        sendMessageWhatsApp: vi.fn(),
        sendMessageTelegram: vi.fn(),
        sendMessageDiscord: vi.fn(),
        sendMessageSignal: vi.fn(),
        sendMessageIMessage: vi.fn(),
      };
      vi.mocked(runEmbeddedPiAgent).mockResolvedValue({
        payloads: [{ text: "ok" }],
        meta: {
          durationMs: 5,
          agentMeta: { sessionId: "s", provider: "p", model: "m" },
        },
      });

      const res = await runCronIsolatedAgentTurn({
        cfg: makeCfg(home, storePath, {
          hooks: {
            gmail: {
              model: "openrouter/meta-llama/llama-3.3-70b:free",
            },
          },
        }),
        deps,
        job: makeJob({ kind: "agentTurn", message: "do it", deliver: false }),
        message: "do it",
        sessionKey: "hook:gmail:msg-1",
        lane: "cron",
      });

      expect(res.status).toBe("ok");
      const call = vi.mocked(runEmbeddedPiAgent).mock.calls[0]?.[0] as {
        provider?: string;
        model?: string;
      };
      expect(call?.provider).toBe("openrouter");
      expect(call?.model).toBe("meta-llama/llama-3.3-70b:free");
    });
  });

  it("ignores hooks.gmail.model when not in the allowlist", async () => {
    await withTempHome(async (home) => {
      const storePath = await writeSessionStore(home);
      const deps: CliDeps = {
        sendMessageWhatsApp: vi.fn(),
        sendMessageTelegram: vi.fn(),
        sendMessageDiscord: vi.fn(),
        sendMessageSignal: vi.fn(),
        sendMessageIMessage: vi.fn(),
      };
      vi.mocked(runEmbeddedPiAgent).mockResolvedValue({
        payloads: [{ text: "ok" }],
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
        },
      ]);

      const res = await runCronIsolatedAgentTurn({
        cfg: makeCfg(home, storePath, {
          agents: {
            defaults: {
              model: "anthropic/claude-opus-4-5",
              models: {
                "anthropic/claude-opus-4-5": { alias: "Opus" },
              },
            },
          },
          hooks: {
            gmail: {
              model: "openrouter/meta-llama/llama-3.3-70b:free",
            },
          },
        }),
        deps,
        job: makeJob({ kind: "agentTurn", message: "do it", deliver: false }),
        message: "do it",
        sessionKey: "hook:gmail:msg-2",
        lane: "cron",
      });

      expect(res.status).toBe("ok");
      const call = vi.mocked(runEmbeddedPiAgent).mock.calls[0]?.[0] as {
        provider?: string;
        model?: string;
      };
      expect(call?.provider).toBe("anthropic");
      expect(call?.model).toBe("claude-opus-4-5");
    });
  });

  it("rejects invalid model override", async () => {
    await withTempHome(async (home) => {
      const storePath = await writeSessionStore(home);
      const deps: CliDeps = {
        sendMessageWhatsApp: vi.fn(),
        sendMessageTelegram: vi.fn(),
        sendMessageDiscord: vi.fn(),
        sendMessageSignal: vi.fn(),
        sendMessageIMessage: vi.fn(),
      };
      vi.mocked(runEmbeddedPiAgent).mockReset();

      const res = await runCronIsolatedAgentTurn({
        cfg: makeCfg(home, storePath),
        deps,
        job: makeJob({
          kind: "agentTurn",
          message: "do it",
          model: "openai/",
        }),
        message: "do it",
        sessionKey: "cron:job-1",
        lane: "cron",
      });

      expect(res.status).toBe("error");
      expect(res.error).toMatch("invalid model");
      expect(vi.mocked(runEmbeddedPiAgent)).not.toHaveBeenCalled();
    });
  });

  it("defaults thinking to low for reasoning-capable models", async () => {
    await withTempHome(async (home) => {
      const storePath = await writeSessionStore(home);
      const deps: CliDeps = {
        sendMessageWhatsApp: vi.fn(),
        sendMessageTelegram: vi.fn(),
        sendMessageDiscord: vi.fn(),
        sendMessageSignal: vi.fn(),
        sendMessageIMessage: vi.fn(),
      };
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

      await runCronIsolatedAgentTurn({
        cfg: makeCfg(home, storePath),
        deps,
        job: makeJob({ kind: "agentTurn", message: "do it", deliver: false }),
        message: "do it",
        sessionKey: "cron:job-1",
        lane: "cron",
      });

      const callArgs = vi.mocked(runEmbeddedPiAgent).mock.calls.at(-1)?.[0];
      expect(callArgs?.thinkLevel).toBe("low");
    });
  });

  it("truncates long summaries", async () => {
    await withTempHome(async (home) => {
      const storePath = await writeSessionStore(home);
      const deps: CliDeps = {
        sendMessageWhatsApp: vi.fn(),
        sendMessageTelegram: vi.fn(),
        sendMessageDiscord: vi.fn(),
        sendMessageSignal: vi.fn(),
        sendMessageIMessage: vi.fn(),
      };
      const long = "a".repeat(2001);
      vi.mocked(runEmbeddedPiAgent).mockResolvedValue({
        payloads: [{ text: long }],
        meta: {
          durationMs: 5,
          agentMeta: { sessionId: "s", provider: "p", model: "m" },
        },
      });

      const res = await runCronIsolatedAgentTurn({
        cfg: makeCfg(home, storePath),
        deps,
        job: makeJob({ kind: "agentTurn", message: "do it", deliver: false }),
        message: "do it",
        sessionKey: "cron:job-1",
        lane: "cron",
      });

      expect(res.status).toBe("ok");
      expect(String(res.summary ?? "")).toMatch(/…$/);
    });
  });

  it("fails delivery without a WhatsApp recipient when bestEffortDeliver=false", async () => {
    await withTempHome(async (home) => {
      const storePath = await writeSessionStore(home);
      const deps: CliDeps = {
        sendMessageWhatsApp: vi.fn(),
        sendMessageTelegram: vi.fn(),
        sendMessageDiscord: vi.fn(),
        sendMessageSignal: vi.fn(),
        sendMessageIMessage: vi.fn(),
      };
      vi.mocked(runEmbeddedPiAgent).mockResolvedValue({
        payloads: [{ text: "hello" }],
        meta: {
          durationMs: 5,
          agentMeta: { sessionId: "s", provider: "p", model: "m" },
        },
      });

      const res = await runCronIsolatedAgentTurn({
        cfg: makeCfg(home, storePath),
        deps,
        job: makeJob({
          kind: "agentTurn",
          message: "do it",
          deliver: true,
          channel: "whatsapp",
          bestEffortDeliver: false,
        }),
        message: "do it",
        sessionKey: "cron:job-1",
        lane: "cron",
      });

      expect(res.status).toBe("error");
      expect(res.summary).toBe("hello");
      expect(String(res.error ?? "")).toMatch(/requires a recipient/i);
      expect(deps.sendMessageWhatsApp).not.toHaveBeenCalled();
    });
  });

  it("starts a fresh session id for each cron run", async () => {
    await withTempHome(async (home) => {
      const storePath = await writeSessionStore(home);
      const deps: CliDeps = {
        sendMessageWhatsApp: vi.fn(),
        sendMessageTelegram: vi.fn(),
        sendMessageDiscord: vi.fn(),
        sendMessageSignal: vi.fn(),
        sendMessageIMessage: vi.fn(),
      };
      vi.mocked(runEmbeddedPiAgent).mockResolvedValue({
        payloads: [{ text: "ok" }],
        meta: {
          durationMs: 5,
          agentMeta: { sessionId: "s", provider: "p", model: "m" },
        },
      });

      const cfg = makeCfg(home, storePath);
      const job = makeJob({ kind: "agentTurn", message: "ping", deliver: false });

      await runCronIsolatedAgentTurn({
        cfg,
        deps,
        job,
        message: "ping",
        sessionKey: "cron:job-1",
        lane: "cron",
      });
      const first = await readSessionEntry(storePath, "agent:main:cron:job-1");

      await runCronIsolatedAgentTurn({
        cfg,
        deps,
        job,
        message: "ping",
        sessionKey: "cron:job-1",
        lane: "cron",
      });
      const second = await readSessionEntry(storePath, "agent:main:cron:job-1");

      expect(first?.sessionId).toBeDefined();
      expect(second?.sessionId).toBeDefined();
      expect(second?.sessionId).not.toBe(first?.sessionId);
    });
  });
});
