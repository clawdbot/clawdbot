import fs from "node:fs/promises";
import { basename, join } from "node:path";
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

import { resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import { abortEmbeddedPiRun, runEmbeddedPiAgent } from "../agents/pi-embedded.js";
import { ensureSandboxWorkspaceForSession } from "../agents/sandbox.js";
import { resolveAgentIdFromSessionKey, resolveSessionKey } from "../config/sessions.js";
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
    { prefix: "clawdbot-triggers-" },
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
  it("stages inbound media into the sandbox workspace", { timeout: 60_000 }, async () => {
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
        agents: {
          defaults: {
            model: "anthropic/claude-opus-4-5",
            workspace: join(home, "clawd"),
            sandbox: {
              mode: "non-main" as const,
              workspaceRoot: join(home, "sandboxes"),
            },
          },
        },
        channels: {
          whatsapp: {
            allowFrom: ["*"],
          },
        },
        session: {
          store: join(home, "sessions.json"),
        },
      };

      const ctx = {
        Body: "hi",
        From: "whatsapp:group:demo",
        To: "+2000",
        ChatType: "group" as const,
        Provider: "whatsapp" as const,
        MediaPath: mediaPath,
        MediaType: "image/jpeg",
        MediaUrl: mediaPath,
      };

      const res = await getReplyFromConfig(ctx, {}, cfg);
      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(text).toBe("ok");
      expect(runEmbeddedPiAgent).toHaveBeenCalledOnce();

      const prompt = vi.mocked(runEmbeddedPiAgent).mock.calls[0]?.[0]?.prompt ?? "";
      const stagedPath = `media/inbound/${basename(mediaPath)}`;
      expect(prompt).toContain(stagedPath);
      expect(prompt).not.toContain(mediaPath);

      const sessionKey = resolveSessionKey(
        cfg.session?.scope ?? "per-sender",
        ctx,
        cfg.session?.mainKey,
      );
      const agentId = resolveAgentIdFromSessionKey(sessionKey);
      const sandbox = await ensureSandboxWorkspaceForSession({
        config: cfg,
        sessionKey,
        workspaceDir: resolveAgentWorkspaceDir(cfg, agentId),
      });
      expect(sandbox).not.toBeNull();
      if (!sandbox) {
        throw new Error("Expected sandbox to be set");
      }
      const stagedFullPath = join(sandbox.workspaceDir, "media", "inbound", basename(mediaPath));
      await expect(fs.stat(stagedFullPath)).resolves.toBeTruthy();
    });
  });
});
