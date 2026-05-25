import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CURRENT_SESSION_VERSION } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ContextEngine } from "../../context-engine/types.js";
import {
  resetCliCompactionTestDeps,
  runCliTurnCompactionLifecycle,
  setCliCompactionTestDeps,
} from "./cli-compaction.js";

function buildContextEngine(params: {
  compactCalls: Array<Parameters<ContextEngine["compact"]>[0]>;
}): ContextEngine {
  return {
    info: {
      id: "legacy",
      name: "Legacy Context Engine",
    },
    async ingest() {
      return { ingested: false };
    },
    async assemble(assembleParams) {
      return { messages: assembleParams.messages, estimatedTokens: 0 };
    },
    async compact(compactParams) {
      params.compactCalls.push(compactParams);
      return {
        ok: true,
        compacted: true,
        result: {
          summary: "compacted",
          tokensBefore: compactParams.currentTokenCount ?? 0,
          tokensAfter: 100,
        },
      };
    },
  };
}

async function writeSessionFile(params: { sessionFile: string; sessionId: string }) {
  await fs.mkdir(path.dirname(params.sessionFile), { recursive: true });
  await fs.writeFile(
    params.sessionFile,
    [
      JSON.stringify({
        type: "session",
        version: CURRENT_SESSION_VERSION,
        id: params.sessionId,
        timestamp: new Date(0).toISOString(),
        cwd: path.dirname(params.sessionFile),
      }),
      JSON.stringify({
        type: "message",
        message: { role: "user", content: "old ask", timestamp: 1 },
      }),
      JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "old answer" }],
          timestamp: 2,
        },
      }),
      "",
    ].join("\n"),
    "utf-8",
  );
}

describe("runCliTurnCompactionLifecycle", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cli-compaction-"));
  });

  afterEach(async () => {
    resetCliCompactionTestDeps();
    vi.clearAllTimers();
    vi.useRealTimers();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("compacts over-budget CLI transcripts and clears external CLI resume state", async () => {
    const sessionKey = "agent:main:cli";
    const sessionId = "session-cli";
    const sessionFile = path.join(tmpDir, "session.jsonl");
    const storePath = path.join(tmpDir, "sessions.json");
    await writeSessionFile({ sessionFile, sessionId });

    const sessionEntry: SessionEntry = {
      sessionId,
      updatedAt: Date.now(),
      sessionFile,
      contextTokens: 1_000,
      totalTokens: 950,
      totalTokensFresh: true,
      cliSessionBindings: {
        "claude-cli": { sessionId: "claude-session" },
      },
      cliSessionIds: {
        "claude-cli": "claude-session",
      },
      claudeCliSessionId: "claude-session",
    };
    const sessionStore: Record<string, SessionEntry> = { [sessionKey]: sessionEntry };
    await fs.writeFile(storePath, JSON.stringify(sessionStore, null, 2), "utf-8");

    const compactCalls: Array<Parameters<ContextEngine["compact"]>[0]> = [];
    const maintenance = vi.fn(async () => ({ changed: false, bytesFreed: 0, rewrittenEntries: 0 }));
    setCliCompactionTestDeps({
      resolveContextEngine: async () => buildContextEngine({ compactCalls }),
      createPreparedEmbeddedPiSettingsManager: async () => ({
        getCompactionReserveTokens: () => 200,
        getCompactionKeepRecentTokens: () => 0,
        applyOverrides: () => {},
      }),
      shouldPreemptivelyCompactBeforePrompt: () => ({
        route: "fits",
        shouldCompact: false,
        estimatedPromptTokens: 600,
        promptBudgetBeforeReserve: 800,
        overflowTokens: 0,
        toolResultReducibleChars: 0,
        effectiveReserveTokens: 200,
      }),
      resolveLiveToolResultMaxChars: () => 20_000,
      runContextEngineMaintenance: maintenance,
    });

    const updatedEntry = await runCliTurnCompactionLifecycle({
      cfg: {} as OpenClawConfig,
      sessionId,
      sessionKey,
      sessionEntry,
      sessionStore,
      storePath,
      sessionAgentId: "main",
      workspaceDir: tmpDir,
      agentDir: tmpDir,
      provider: "claude-cli",
      model: "opus",
    });

    expect(compactCalls).toHaveLength(1);
    const compactCall = compactCalls[0];
    expect(compactCall?.sessionId).toBe(sessionId);
    expect(compactCall?.sessionKey).toBe(sessionKey);
    expect(compactCall?.sessionFile).toBe(sessionFile);
    expect(compactCall?.tokenBudget).toBe(1_000);
    expect(compactCall?.currentTokenCount).toBe(950);
    expect(compactCall?.force).toBe(true);
    expect(compactCall?.compactionTarget).toBe("budget");
    expect(maintenance).toHaveBeenCalledTimes(1);
    const maintenanceCalls = maintenance.mock.calls as unknown as Array<
      [
        {
          reason?: string;
          sessionId?: string;
          sessionKey?: string;
          sessionFile?: string;
        },
      ]
    >;
    const maintenanceCall = maintenanceCalls[0]?.[0];
    expect(maintenanceCall?.reason).toBe("compaction");
    expect(maintenanceCall?.sessionId).toBe(sessionId);
    expect(maintenanceCall?.sessionKey).toBe(sessionKey);
    expect(maintenanceCall?.sessionFile).toBe(sessionFile);
    expect(updatedEntry?.compactionCount).toBe(1);
    expect(updatedEntry?.cliSessionBindings?.["claude-cli"]).toBeUndefined();
    expect(updatedEntry?.cliSessionIds?.["claude-cli"]).toBeUndefined();
    expect(updatedEntry?.claudeCliSessionId).toBeUndefined();
  });

  it("skips OpenClaw automatic CLI compaction for OpenAI Codex runtime sessions", async () => {
    const sessionKey = "agent:main:codex";
    const sessionId = "session-codex";
    const sessionFile = path.join(tmpDir, "session-codex.jsonl");
    const storePath = path.join(tmpDir, "sessions-codex.json");
    await writeSessionFile({ sessionFile, sessionId });

    const sessionEntry: SessionEntry = {
      sessionId,
      updatedAt: Date.now(),
      sessionFile,
      contextTokens: 1_000,
      totalTokens: 950,
      totalTokensFresh: true,
      agentHarnessId: "codex",
    };
    const sessionStore: Record<string, SessionEntry> = { [sessionKey]: sessionEntry };
    await fs.writeFile(storePath, JSON.stringify(sessionStore, null, 2), "utf-8");

    const compactCalls: Array<Parameters<ContextEngine["compact"]>[0]> = [];
    const resolveContextEngine = vi.fn(async () => buildContextEngine({ compactCalls }));
    const ensureSelectedAgentHarnessPlugin = vi.fn(async () => undefined);
    const compactAgentHarnessSession = vi.fn(async () => ({
      ok: true,
      compacted: true,
      result: { tokensBefore: 950, tokensAfter: 100 },
    }));
    const applyPiAutoCompactionGuard = vi.fn(async () => ({
      supported: true,
      disabled: false,
    }));
    const recordCliCompactionInStore = vi.fn(async () => ({
      ...sessionEntry,
      compactionCount: 1,
    }));
    setCliCompactionTestDeps({
      resolveContextEngine,
      ensureSelectedAgentHarnessPlugin,
      maybeCompactAgentHarnessSession: compactAgentHarnessSession as never,
      createPreparedEmbeddedPiSettingsManager: async () => ({
        getCompactionReserveTokens: () => 200,
        getCompactionKeepRecentTokens: () => 0,
        applyOverrides: () => {},
      }),
      shouldPreemptivelyCompactBeforePrompt: () => ({
        route: "fits",
        shouldCompact: false,
        estimatedPromptTokens: 600,
        promptBudgetBeforeReserve: 800,
        overflowTokens: 0,
        toolResultReducibleChars: 0,
        effectiveReserveTokens: 200,
      }),
      resolveLiveToolResultMaxChars: () => 20_000,
      applyPiAutoCompactionGuard,
      recordCliCompactionInStore,
    });

    const updatedEntry = await runCliTurnCompactionLifecycle({
      cfg: {} as OpenClawConfig,
      sessionId,
      sessionKey,
      sessionEntry,
      sessionStore,
      storePath,
      sessionAgentId: "main",
      workspaceDir: tmpDir,
      agentDir: tmpDir,
      provider: "openai",
      model: "gpt-5.5",
    });

    expect(resolveContextEngine).not.toHaveBeenCalled();
    expect(applyPiAutoCompactionGuard).not.toHaveBeenCalled();
    expect(ensureSelectedAgentHarnessPlugin).not.toHaveBeenCalled();
    expect(compactAgentHarnessSession).not.toHaveBeenCalled();
    expect(compactCalls).toHaveLength(0);
    expect(recordCliCompactionInStore).not.toHaveBeenCalled();
    expect(updatedEntry).toBe(sessionEntry);
  });

  it("skips OpenClaw automatic CLI compaction when OpenAI resolves to Codex by policy", async () => {
    const sessionKey = "agent:main:codex-policy";
    const sessionId = "session-codex-policy";
    const sessionFile = path.join(tmpDir, "session-codex-policy.jsonl");
    const storePath = path.join(tmpDir, "sessions-codex-policy.json");
    await writeSessionFile({ sessionFile, sessionId });

    const sessionEntry: SessionEntry = {
      sessionId,
      updatedAt: Date.now(),
      sessionFile,
      contextTokens: 1_000,
      totalTokens: 950,
      totalTokensFresh: true,
    };
    const sessionStore: Record<string, SessionEntry> = { [sessionKey]: sessionEntry };
    await fs.writeFile(storePath, JSON.stringify(sessionStore, null, 2), "utf-8");

    const openSessionManager = vi.fn(() => {
      throw new Error("OpenClaw must not inspect Codex transcripts for automatic compaction");
    });
    const resolveContextEngine = vi.fn();
    const ensureSelectedAgentHarnessPlugin = vi.fn();
    const compactAgentHarnessSession = vi.fn();
    setCliCompactionTestDeps({
      openSessionManager: openSessionManager as never,
      resolveContextEngine: resolveContextEngine as never,
      ensureSelectedAgentHarnessPlugin: ensureSelectedAgentHarnessPlugin as never,
      maybeCompactAgentHarnessSession: compactAgentHarnessSession as never,
    });

    const updatedEntry = await runCliTurnCompactionLifecycle({
      cfg: {} as OpenClawConfig,
      sessionId,
      sessionKey,
      sessionEntry,
      sessionStore,
      storePath,
      sessionAgentId: "main",
      workspaceDir: tmpDir,
      agentDir: tmpDir,
      provider: "openai",
      model: "gpt-5.5",
    });

    expect(openSessionManager).not.toHaveBeenCalled();
    expect(resolveContextEngine).not.toHaveBeenCalled();
    expect(ensureSelectedAgentHarnessPlugin).not.toHaveBeenCalled();
    expect(compactAgentHarnessSession).not.toHaveBeenCalled();
    expect(updatedEntry).toBe(sessionEntry);
  });

  it("ignores stale native harness ids when the active provider no longer matches", async () => {
    const sessionKey = "agent:main:pi-after-codex";
    const sessionId = "session-pi-after-codex";
    const sessionFile = path.join(tmpDir, "session-pi-after-codex.jsonl");
    const storePath = path.join(tmpDir, "sessions-pi-after-codex.json");
    await writeSessionFile({ sessionFile, sessionId });

    const sessionEntry: SessionEntry = {
      sessionId,
      updatedAt: Date.now(),
      sessionFile,
      contextTokens: 1_000,
      totalTokens: 950,
      totalTokensFresh: true,
      agentHarnessId: "codex",
    };
    const sessionStore: Record<string, SessionEntry> = { [sessionKey]: sessionEntry };
    await fs.writeFile(storePath, JSON.stringify(sessionStore, null, 2), "utf-8");

    const compactCalls: Array<Parameters<ContextEngine["compact"]>[0]> = [];
    const compactAgentHarnessSession = vi.fn();
    setCliCompactionTestDeps({
      resolveContextEngine: async () => buildContextEngine({ compactCalls }),
      maybeCompactAgentHarnessSession: compactAgentHarnessSession as never,
      createPreparedEmbeddedPiSettingsManager: async () => ({
        getCompactionReserveTokens: () => 200,
        getCompactionKeepRecentTokens: () => 0,
        applyOverrides: () => {},
      }),
      shouldPreemptivelyCompactBeforePrompt: () => ({
        route: "fits",
        shouldCompact: false,
        estimatedPromptTokens: 600,
        promptBudgetBeforeReserve: 800,
        overflowTokens: 0,
        toolResultReducibleChars: 0,
        effectiveReserveTokens: 200,
      }),
      resolveLiveToolResultMaxChars: () => 20_000,
      runContextEngineMaintenance: vi.fn(async () => ({
        changed: false,
        bytesFreed: 0,
        rewrittenEntries: 0,
      })),
    });

    await runCliTurnCompactionLifecycle({
      cfg: {} as OpenClawConfig,
      sessionId,
      sessionKey,
      sessionEntry,
      sessionStore,
      storePath,
      sessionAgentId: "main",
      workspaceDir: tmpDir,
      agentDir: tmpDir,
      provider: "pi",
      model: "sonnet-4.6",
    });

    expect(compactAgentHarnessSession).not.toHaveBeenCalled();
    expect(compactCalls).toHaveLength(1);
  });

  it("falls back to context-engine compaction when a pinned harness has no native compactor", async () => {
    const sessionKey = "agent:main:external-harness";
    const sessionId = "session-external-harness";
    const sessionFile = path.join(tmpDir, "session-external-harness.jsonl");
    const storePath = path.join(tmpDir, "sessions-external-harness.json");
    await writeSessionFile({ sessionFile, sessionId });

    const sessionEntry: SessionEntry = {
      sessionId,
      updatedAt: Date.now(),
      sessionFile,
      contextTokens: 1_000,
      totalTokens: 950,
      totalTokensFresh: true,
      agentHarnessId: "external-harness",
    };
    const sessionStore: Record<string, SessionEntry> = { [sessionKey]: sessionEntry };
    await fs.writeFile(storePath, JSON.stringify(sessionStore, null, 2), "utf-8");

    const compactCalls: Array<Parameters<ContextEngine["compact"]>[0]> = [];
    const ensureSelectedAgentHarnessPlugin = vi.fn(async () => undefined);
    const compactAgentHarnessSession = vi.fn(async () => ({
      ok: false,
      compacted: false,
      reason: 'Agent harness "external-harness" does not support compaction.',
      failure: { reason: "unsupported_harness_compaction" },
    }));
    const maintenance = vi.fn(async () => ({ changed: false, bytesFreed: 0, rewrittenEntries: 0 }));
    const recordCliCompactionInStore = vi.fn(async () => ({
      ...sessionEntry,
      compactionCount: 1,
    }));
    setCliCompactionTestDeps({
      resolveContextEngine: async () => buildContextEngine({ compactCalls }),
      ensureSelectedAgentHarnessPlugin,
      maybeCompactAgentHarnessSession: compactAgentHarnessSession as never,
      createPreparedEmbeddedPiSettingsManager: async () => ({
        getCompactionReserveTokens: () => 200,
        getCompactionKeepRecentTokens: () => 0,
        applyOverrides: () => {},
      }),
      shouldPreemptivelyCompactBeforePrompt: () => ({
        route: "fits",
        shouldCompact: false,
        estimatedPromptTokens: 600,
        promptBudgetBeforeReserve: 800,
        overflowTokens: 0,
        toolResultReducibleChars: 0,
        effectiveReserveTokens: 200,
      }),
      resolveLiveToolResultMaxChars: () => 20_000,
      runContextEngineMaintenance: maintenance,
      recordCliCompactionInStore,
    });

    const updatedEntry = await runCliTurnCompactionLifecycle({
      cfg: {} as OpenClawConfig,
      sessionId,
      sessionKey,
      sessionEntry,
      sessionStore,
      storePath,
      sessionAgentId: "main",
      workspaceDir: tmpDir,
      agentDir: tmpDir,
      provider: "external-harness",
      model: "model",
    });

    expect(compactAgentHarnessSession).toHaveBeenCalledTimes(1);
    expect(compactCalls).toHaveLength(1);
    expect(maintenance).toHaveBeenCalledTimes(1);
    expect(recordCliCompactionInStore).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "external-harness",
        sessionKey,
        tokensAfter: undefined,
      }),
    );
    expect(updatedEntry?.compactionCount).toBe(1);
  });

  it("keeps successful context-engine fallback when post-compaction maintenance fails", async () => {
    const sessionKey = "agent:main:external-harness-stale-maintenance";
    const sessionId = "session-external-harness-stale-maintenance";
    const sessionFile = path.join(tmpDir, "session-external-harness-stale-maintenance.jsonl");
    const storePath = path.join(tmpDir, "sessions-external-harness-stale-maintenance.json");
    await writeSessionFile({ sessionFile, sessionId });

    const sessionEntry: SessionEntry = {
      sessionId,
      updatedAt: Date.now(),
      sessionFile,
      contextTokens: 1_000,
      totalTokens: 950,
      totalTokensFresh: true,
      agentHarnessId: "external-harness",
    };
    const sessionStore: Record<string, SessionEntry> = { [sessionKey]: sessionEntry };
    await fs.writeFile(storePath, JSON.stringify(sessionStore, null, 2), "utf-8");

    const compactCalls: Array<Parameters<ContextEngine["compact"]>[0]> = [];
    const maintenance = vi.fn(async () => {
      throw new Error("maintenance rotated stale binding");
    });
    const recordCliCompactionInStore = vi.fn(async () => ({
      ...sessionEntry,
      compactionCount: 1,
    }));
    setCliCompactionTestDeps({
      resolveContextEngine: async () => buildContextEngine({ compactCalls }),
      ensureSelectedAgentHarnessPlugin: vi.fn(async () => undefined),
      maybeCompactAgentHarnessSession: vi.fn(async () => ({
        ok: false,
        compacted: false,
        reason: "thread not found: thread-1",
        failure: { reason: "stale_thread_binding" },
      })) as never,
      createPreparedEmbeddedPiSettingsManager: async () => ({
        getCompactionReserveTokens: () => 200,
        getCompactionKeepRecentTokens: () => 0,
        applyOverrides: () => {},
      }),
      shouldPreemptivelyCompactBeforePrompt: () => ({
        route: "fits",
        shouldCompact: false,
        estimatedPromptTokens: 600,
        promptBudgetBeforeReserve: 800,
        overflowTokens: 0,
        toolResultReducibleChars: 0,
        effectiveReserveTokens: 200,
      }),
      resolveLiveToolResultMaxChars: () => 20_000,
      runContextEngineMaintenance: maintenance,
      recordCliCompactionInStore,
    });

    const updatedEntry = await runCliTurnCompactionLifecycle({
      cfg: {} as OpenClawConfig,
      sessionId,
      sessionKey,
      sessionEntry,
      sessionStore,
      storePath,
      sessionAgentId: "main",
      workspaceDir: tmpDir,
      agentDir: tmpDir,
      provider: "external-harness",
      model: "model",
    });

    expect(compactCalls).toHaveLength(1);
    expect(maintenance).toHaveBeenCalledTimes(1);
    expect(recordCliCompactionInStore).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "external-harness", sessionKey }),
    );
    expect(updatedEntry?.compactionCount).toBe(1);
  });

  it("initializes built-in context engines before resolving CLI compaction engine", async () => {
    const sessionKey = "agent:main:cli";
    const sessionId = "session-cli-init";
    const sessionFile = path.join(tmpDir, "session-init.jsonl");
    await writeSessionFile({ sessionFile, sessionId });

    const sessionEntry: SessionEntry = {
      sessionId,
      updatedAt: Date.now(),
      sessionFile,
      contextTokens: 1_000,
      totalTokens: 950,
      totalTokensFresh: true,
    };
    const calls: string[] = [];
    setCliCompactionTestDeps({
      ensureContextEnginesInitialized: () => {
        calls.push("ensure");
      },
      resolveContextEngine: async () => {
        calls.push("resolve");
        return buildContextEngine({ compactCalls: [] });
      },
      createPreparedEmbeddedPiSettingsManager: async () => ({
        getCompactionReserveTokens: () => 200,
        getCompactionKeepRecentTokens: () => 0,
        applyOverrides: () => {},
      }),
      shouldPreemptivelyCompactBeforePrompt: () => ({
        route: "fits",
        shouldCompact: false,
        estimatedPromptTokens: 600,
        promptBudgetBeforeReserve: 800,
        overflowTokens: 0,
        toolResultReducibleChars: 0,
        effectiveReserveTokens: 200,
      }),
      resolveLiveToolResultMaxChars: () => 20_000,
    });

    await runCliTurnCompactionLifecycle({
      cfg: {} as OpenClawConfig,
      sessionId,
      sessionKey,
      sessionEntry,
      sessionAgentId: "main",
      workspaceDir: tmpDir,
      agentDir: tmpDir,
      provider: "claude-cli",
      model: "opus",
    });

    expect(calls).toEqual(["ensure", "resolve"]);
  });

  it("bounds a hung CLI context-engine compaction and leaves resume state intact", async () => {
    const sessionKey = "agent:main:cli";
    const sessionId = "session-cli-timeout";
    const sessionFile = path.join(tmpDir, "session-timeout.jsonl");
    const storePath = path.join(tmpDir, "sessions-timeout.json");
    await writeSessionFile({ sessionFile, sessionId });

    const sessionEntry: SessionEntry = {
      sessionId,
      updatedAt: Date.now(),
      sessionFile,
      contextTokens: 1_000,
      totalTokens: 950,
      totalTokensFresh: true,
      cliSessionBindings: {
        "claude-cli": { sessionId: "claude-session" },
      },
      cliSessionIds: {
        "claude-cli": "claude-session",
      },
      claudeCliSessionId: "claude-session",
    };
    const sessionStore: Record<string, SessionEntry> = { [sessionKey]: sessionEntry };
    await fs.writeFile(storePath, JSON.stringify(sessionStore, null, 2), "utf-8");

    const compactCalls: Array<Parameters<ContextEngine["compact"]>[0]> = [];
    const maintenance = vi.fn(async () => ({ changed: false, bytesFreed: 0, rewrittenEntries: 0 }));
    const recordCliCompactionInStore = vi.fn();
    setCliCompactionTestDeps({
      resolveContextEngine: async () => ({
        ...buildContextEngine({ compactCalls }),
        async compact(compactParams) {
          compactCalls.push(compactParams);
          return await new Promise(() => {});
        },
      }),
      createPreparedEmbeddedPiSettingsManager: async () => ({
        getCompactionReserveTokens: () => 200,
        getCompactionKeepRecentTokens: () => 0,
        applyOverrides: () => {},
      }),
      shouldPreemptivelyCompactBeforePrompt: () => ({
        route: "fits",
        shouldCompact: false,
        estimatedPromptTokens: 600,
        promptBudgetBeforeReserve: 800,
        overflowTokens: 0,
        toolResultReducibleChars: 0,
        effectiveReserveTokens: 200,
      }),
      resolveLiveToolResultMaxChars: () => 20_000,
      runContextEngineMaintenance: maintenance,
      recordCliCompactionInStore,
    });

    vi.useFakeTimers();
    const pending = runCliTurnCompactionLifecycle({
      cfg: { agents: { defaults: { compaction: { timeoutSeconds: 1 } } } } as OpenClawConfig,
      sessionId,
      sessionKey,
      sessionEntry,
      sessionStore,
      storePath,
      sessionAgentId: "main",
      workspaceDir: tmpDir,
      agentDir: tmpDir,
      provider: "claude-cli",
      model: "opus",
    });

    const rejection = expect(pending).rejects.toThrow(
      "CLI transcript compaction failed for claude-cli/opus: Compaction timed out",
    );
    await vi.advanceTimersByTimeAsync(1_000);
    await rejection;
    vi.useRealTimers();

    expect(compactCalls).toHaveLength(1);
    expect(compactCalls[0]?.abortSignal).toBeInstanceOf(AbortSignal);
    expect(compactCalls[0]?.abortSignal?.aborted).toBe(true);
    expect(maintenance).not.toHaveBeenCalled();
    expect(recordCliCompactionInStore).not.toHaveBeenCalled();
    expect(sessionStore[sessionKey]?.cliSessionBindings?.["claude-cli"]?.sessionId).toBe(
      "claude-session",
    );
  });
});
