import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionScope } from "../config/sessions/types.js";

const agentCommand = vi.fn();

vi.mock("../commands/agent.js", () => ({
  agentCommand,
  agentCommandFromIngress: agentCommand,
}));

const { runBootOnce } = await import("./boot.js");
const { resolveAgentIdFromSessionKey, resolveAgentMainSessionKey, resolveMainSessionKey } =
  await import("../config/sessions/main-session.js");
const { resolveStorePath } = await import("../config/sessions/paths.js");
const { loadSessionStore, saveSessionStore } = await import("../config/sessions/store.js");

describe("runBootOnce", () => {
  type BootWorkspaceOptions = {
    bootAsDirectory?: boolean;
    bootContent?: string;
  };

  const resolveMainStore = (
    cfg: {
      session?: { store?: string; scope?: SessionScope; mainKey?: string };
      agents?: { list?: Array<{ id?: string; default?: boolean }> };
    } = {},
  ) => {
    const sessionKey = resolveMainSessionKey(cfg);
    const agentId = resolveAgentIdFromSessionKey(sessionKey);
    const storePath = resolveStorePath(cfg.session?.store, { agentId });
    return { sessionKey, storePath };
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    const { storePath } = resolveMainStore();
    await fs.rm(storePath, { force: true });
  });

  const makeDeps = () => ({
    sendMessageWhatsApp: vi.fn(),
    sendMessageTelegram: vi.fn(),
    sendMessageDiscord: vi.fn(),
    sendMessageSlack: vi.fn(),
    sendMessageSignal: vi.fn(),
    sendMessageIMessage: vi.fn(),
  });

  const withBootWorkspace = async (
    options: BootWorkspaceOptions,
    run: (workspaceDir: string) => Promise<void>,
  ) => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-boot-"));
    try {
      const bootPath = path.join(workspaceDir, "BOOT.md");
      if (options.bootAsDirectory) {
        await fs.mkdir(bootPath, { recursive: true });
      } else if (typeof options.bootContent === "string") {
        await fs.writeFile(bootPath, options.bootContent, "utf-8");
      }
      await run(workspaceDir);
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  };

  const mockAgentUpdatesMainSession = (storePath: string, sessionKey: string) => {
    agentCommand.mockImplementation(async (opts: { sessionId?: string }) => {
      const current = loadSessionStore(storePath, { skipCache: true });
      current[sessionKey] = {
        sessionId: String(opts.sessionId),
        updatedAt: Date.now(),
      };
      await saveSessionStore(storePath, current);
    });
  };

  const expectMainSessionRestored = (params: {
    storePath: string;
    sessionKey: string;
    expectedSessionId?: string;
  }) => {
    const restored = loadSessionStore(params.storePath, { skipCache: true });
    if (params.expectedSessionId === undefined) {
      expect(restored[params.sessionKey]).toBeUndefined();
      return;
    }
    expect(restored[params.sessionKey]?.sessionId).toBe(params.expectedSessionId);
  };

  it("skips when BOOT.md is missing", async () => {
    await withBootWorkspace({}, async (workspaceDir) => {
      await expect(runBootOnce({ cfg: {}, deps: makeDeps(), workspaceDir })).resolves.toEqual({
        status: "skipped",
        reason: "missing",
      });
      expect(agentCommand).not.toHaveBeenCalled();
    });
  });

  it("returns failed when BOOT.md cannot be read", async () => {
    await withBootWorkspace({ bootAsDirectory: true }, async (workspaceDir) => {
      const result = await runBootOnce({ cfg: {}, deps: makeDeps(), workspaceDir });
      expect(result.status).toBe("failed");
      if (result.status === "failed") {
        expect(result.reason.length).toBeGreaterThan(0);
      }
      expect(agentCommand).not.toHaveBeenCalled();
    });
  });

  it.each([
    { title: "empty", content: "   \n", reason: "empty" as const },
    { title: "whitespace-only", content: "\n\t ", reason: "empty" as const },
  ])("skips when BOOT.md is $title", async ({ content, reason }) => {
    await withBootWorkspace({ bootContent: content }, async (workspaceDir) => {
      await expect(runBootOnce({ cfg: {}, deps: makeDeps(), workspaceDir })).resolves.toEqual({
        status: "skipped",
        reason,
      });
      expect(agentCommand).not.toHaveBeenCalled();
    });
  });

  it("runs agent command when BOOT.md exists", async () => {
    const content = "Say hello when you wake up.";
    await withBootWorkspace({ bootContent: content }, async (workspaceDir) => {
      agentCommand.mockResolvedValue(undefined);
      await expect(runBootOnce({ cfg: {}, deps: makeDeps(), workspaceDir })).resolves.toEqual({
        status: "ran",
      });

      expect(agentCommand).toHaveBeenCalledTimes(1);
      const call = agentCommand.mock.calls[0]?.[0];
      expect(call?.deliver).toBe(false);
      expect(call?.sessionKey).toBe(resolveMainSessionKey({}));
      expect(call?.message).toContain("BOOT.md:");
      expect(call?.message).toContain(content);
      expect(call?.message).toContain("NO_REPLY");
    });
  });

  it("returns failed when agent command throws", async () => {
    await withBootWorkspace({ bootContent: "Wake up and report." }, async (workspaceDir) => {
      agentCommand.mockRejectedValue(new Error("boom"));
      await expect(runBootOnce({ cfg: {}, deps: makeDeps(), workspaceDir })).resolves.toEqual({
        status: "failed",
        reason: "agent run failed: boom",
      });
      expect(agentCommand).toHaveBeenCalledTimes(1);
    });
  });

  it("uses per-agent session key when agentId is provided", async () => {
    await withBootWorkspace({ bootContent: "Check status." }, async (workspaceDir) => {
      agentCommand.mockResolvedValue(undefined);
      const cfg = {};
      const agentId = "ops";
      await expect(runBootOnce({ cfg, deps: makeDeps(), workspaceDir, agentId })).resolves.toEqual({
        status: "ran",
      });

      expect(agentCommand).toHaveBeenCalledTimes(1);
      const perAgentCall = agentCommand.mock.calls[0]?.[0];
      expect(perAgentCall?.sessionKey).toBe(resolveAgentMainSessionKey({ cfg, agentId }));
    });
  });

  it("generates new session ID when no existing session exists", async () => {
    const content = "Say hello when you wake up.";
    await withBootWorkspace({ bootContent: content }, async (workspaceDir) => {
      agentCommand.mockResolvedValue(undefined);
      const cfg = {};
      await expect(runBootOnce({ cfg, deps: makeDeps(), workspaceDir })).resolves.toEqual({
        status: "ran",
      });

      expect(agentCommand).toHaveBeenCalledTimes(1);
      const call = agentCommand.mock.calls[0]?.[0];

      // Verify a boot-style session ID was generated (format: boot-YYYY-MM-DD_HH-MM-SS-xxx-xxxxxxxx)
      expect(call?.sessionId).toMatch(
        /^boot-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}-\d{3}-[0-9a-f]{8}$/,
      );
    });
  });

  it("uses a fresh boot session ID even when main session mapping already exists", async () => {
    const content = "Say hello when you wake up.";
    await withBootWorkspace({ bootContent: content }, async (workspaceDir) => {
      const cfg = {};
      const { sessionKey, storePath } = resolveMainStore(cfg);
      const existingSessionId = "main-session-abc123";

      await saveSessionStore(storePath, {
        [sessionKey]: {
          sessionId: existingSessionId,
          updatedAt: Date.now(),
        },
      });

      agentCommand.mockResolvedValue(undefined);
      await expect(runBootOnce({ cfg, deps: makeDeps(), workspaceDir })).resolves.toEqual({
        status: "ran",
      });

      expect(agentCommand).toHaveBeenCalledTimes(1);
      const call = agentCommand.mock.calls[0]?.[0];

      expect(call?.sessionId).not.toBe(existingSessionId);
      expect(call?.sessionId).toMatch(
        /^boot-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}-\d{3}-[0-9a-f]{8}$/,
      );
      expect(call?.sessionKey).toBe(sessionKey);
    });
  });

  it("restores the original main session mapping after the boot run", async () => {
    const content = "Check if the system is healthy.";
    await withBootWorkspace({ bootContent: content }, async (workspaceDir) => {
      const cfg = {};
      const { sessionKey, storePath } = resolveMainStore(cfg);
      const existingSessionId = "main-session-xyz789";

      await saveSessionStore(storePath, {
        [sessionKey]: {
          sessionId: existingSessionId,
          updatedAt: Date.now() - 60_000, // 1 minute ago
        },
      });

      mockAgentUpdatesMainSession(storePath, sessionKey);
      await expect(runBootOnce({ cfg, deps: makeDeps(), workspaceDir })).resolves.toEqual({
        status: "ran",
      });

      expectMainSessionRestored({ storePath, sessionKey, expectedSessionId: existingSessionId });
    });
  });

  it("removes a boot-created main-session mapping when none existed before", async () => {
    await withBootWorkspace({ bootContent: "health check" }, async (workspaceDir) => {
      const cfg = {};
      const { sessionKey, storePath } = resolveMainStore(cfg);

      mockAgentUpdatesMainSession(storePath, sessionKey);

      await expect(runBootOnce({ cfg, deps: makeDeps(), workspaceDir })).resolves.toEqual({
        status: "ran",
      });

      expectMainSessionRestored({ storePath, sessionKey });
    });
  });
});
