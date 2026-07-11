// Covers CLI turn compaction lifecycle and external CLI resume-state cleanup.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CURRENT_SESSION_VERSION } from "openclaw/plugin-sdk/agent-sessions";
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
  // The lifecycle compacts canonical OpenClaw session JSONL, so tests write the
  // same session/message envelope the real store appends.
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
    setCliCompactionTestDeps({ resolveCliBackendConfig: () => null });
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
    const taskCwd = path.join(tmpDir, "task-repo");
    await fs.mkdir(taskCwd, { recursive: true });
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
    const settingsCwds: string[] = [];
    // Compaction settings should be resolved against the task cwd, not the
    // bootstrap workspace, because CLI prompts may run from nested repos.
    setCliCompactionTestDeps({
      resolveContextEngine: async () => buildContextEngine({ compactCalls }),
      createPreparedEmbeddedAgentSettingsManager: async (params) => {
        settingsCwds.push(params.cwd);
        return {
          getCompactionReserveTokens: () => 200,
          getCompactionKeepRecentTokens: () => 0,
          applyOverrides: () => {},
        };
      },
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
      cwd: taskCwd,
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
    expect(compactCall?.runtimeContext?.workspaceDir).toBe(tmpDir);
    expect(compactCall?.runtimeContext?.cwd).toBe(taskCwd);
    expect(settingsCwds).toEqual([taskCwd]);
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
    // Once OpenClaw rewrites the transcript, external CLI resume ids are stale
    // and must be cleared so the next turn starts from the compacted prompt.
    expect(updatedEntry?.cliSessionBindings?.["claude-cli"]).toBeUndefined();
    expect(updatedEntry?.cliSessionIds?.["claude-cli"]).toBeUndefined();
    expect(updatedEntry?.claudeCliSessionId).toBeUndefined();
  });

  it("treats below-target CLI transcript compaction as a no-op", async () => {
    const sessionKey = "agent:main:cli-under-target";
    const sessionId = "session-cli-under-target";
    const sessionFile = path.join(tmpDir, "session-under-target.jsonl");
    const storePath = path.join(tmpDir, "sessions-under-target.json");
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
          return {
            ok: true,
            compacted: false,
            reason: "already under target",
          };
        },
      }),
      createPreparedEmbeddedAgentSettingsManager: async () => ({
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
      provider: "claude-cli",
      model: "opus",
    });

    expect(compactCalls).toHaveLength(1);
    expect(maintenance).not.toHaveBeenCalled();
    expect(recordCliCompactionInStore).not.toHaveBeenCalled();
    expect(updatedEntry).toBe(sessionEntry);
    expect(sessionStore[sessionKey]?.cliSessionBindings?.["claude-cli"]?.sessionId).toBe(
      "claude-session",
    );
  });

  it("treats already-compacted CLI transcript compaction as a no-op", async () => {
    const sessionKey = "agent:main:qwen-already-compacted";
    const sessionId = "session-qwen-already-compacted";
    const sessionFile = path.join(tmpDir, "session-qwen-already-compacted.jsonl");
    const storePath = path.join(tmpDir, "sessions-qwen-already-compacted.json");
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

    const compactCalls: Array<Parameters<ContextEngine["compact"]>[0]> = [];
    const maintenance = vi.fn(async () => ({ changed: false, bytesFreed: 0, rewrittenEntries: 0 }));
    const recordCliCompactionInStore = vi.fn();
    setCliCompactionTestDeps({
      resolveContextEngine: async () => ({
        ...buildContextEngine({ compactCalls }),
        async compact(compactParams) {
          compactCalls.push(compactParams);
          throw new Error("Already compacted");
        },
      }),
      createPreparedEmbeddedAgentSettingsManager: async () => ({
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
      provider: "ollama",
      model: "qwen3:14b",
    });

    expect(compactCalls).toHaveLength(1);
    expect(maintenance).not.toHaveBeenCalled();
    expect(recordCliCompactionInStore).not.toHaveBeenCalled();
    expect(updatedEntry).toBe(sessionEntry);
  });

  it("routes OpenAI Codex harness CLI compaction through native harness compaction", async () => {
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
      modelSelectionLocked: true,
      authProfileOverride: "github-copilot:work",
      authProfileOverrideSource: "auto",
    };
    const sessionStore: Record<string, SessionEntry> = { [sessionKey]: sessionEntry };
    await fs.writeFile(storePath, JSON.stringify(sessionStore, null, 2), "utf-8");

    const compactCalls: Array<Parameters<ContextEngine["compact"]>[0]> = [];
    const contextEngine = buildContextEngine({ compactCalls });
    const resolveContextEngine = vi.fn(async () => contextEngine);
    const ensureSelectedAgentHarnessPlugin = vi.fn(async () => undefined);
    const compactAgentHarnessSession = vi.fn(async () => ({
      ok: true,
      compacted: true,
      result: { tokensBefore: 950, tokensAfter: 100 },
    }));
    const applyAgentAutoCompactionGuard = vi.fn(async () => ({
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
      createPreparedEmbeddedAgentSettingsManager: async () => ({
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
      applyAgentAutoCompactionGuard,
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

    expect(resolveContextEngine).toHaveBeenCalledTimes(1);
    expect(applyAgentAutoCompactionGuard).toHaveBeenCalledWith(
      expect.objectContaining({
        contextEngineInfo: contextEngine.info,
      }),
    );
    expect(ensureSelectedAgentHarnessPlugin).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai",
        modelId: "gpt-5.5",
        sessionKey,
        agentHarnessRuntimeOverride: "codex",
      }),
    );
    expect(applyAgentAutoCompactionGuard.mock.invocationCallOrder[0] ?? 0).toBeLessThan(
      compactAgentHarnessSession.mock.invocationCallOrder[0] ?? 0,
    );
    expect(compactAgentHarnessSession).toHaveBeenCalledTimes(1);
    const compactAgentHarnessSessionCalls = compactAgentHarnessSession.mock
      .calls as unknown as Array<[Record<string, unknown>]>;
    expect(compactAgentHarnessSessionCalls[0]?.[0]).toMatchObject({
      sessionId,
      sessionKey,
      sessionFile,
      provider: "openai",
      model: "gpt-5.5",
      contextTokenBudget: 1_000,
      currentTokenCount: 950,
      contextEngine,
      agentHarnessId: "codex",
      modelSelectionLocked: true,
      authProfileId: "github-copilot:work",
      trigger: "budget",
      force: true,
    });
    expect(compactAgentHarnessSessionCalls[0]?.[0].contextEngineRuntimeContext).toMatchObject({
      authProfileId: "github-copilot:work",
      agentHarnessId: "codex",
      modelSelectionLocked: true,
    });
    expect(compactCalls).toHaveLength(0);
    expect(recordCliCompactionInStore).toHaveBeenCalledTimes(1);
    expect(recordCliCompactionInStore).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai",
        sessionKey,
        tokensAfter: 100,
      }),
    );
    expect(updatedEntry?.compactionCount).toBe(1);
  });

  it("treats below-target Copilot native CLI compaction as a no-op", async () => {
    const sessionKey = "agent:main:copilot-under-target";
    const sessionId = "session-copilot-under-target";
    const sessionFile = path.join(tmpDir, "session-copilot-under-target.jsonl");
    const storePath = path.join(tmpDir, "sessions-copilot-under-target.json");
    await writeSessionFile({ sessionFile, sessionId });

    const sessionEntry: SessionEntry = {
      sessionId,
      updatedAt: Date.now(),
      sessionFile,
      contextTokens: 1_000,
      totalTokens: 950,
      totalTokensFresh: true,
      agentHarnessId: "copilot",
    };
    const sessionStore: Record<string, SessionEntry> = { [sessionKey]: sessionEntry };
    await fs.writeFile(storePath, JSON.stringify(sessionStore, null, 2), "utf-8");

    const compactCalls: Array<Parameters<ContextEngine["compact"]>[0]> = [];
    const compactAgentHarnessSession = vi.fn(async () => ({
      ok: true,
      compacted: false,
      reason: "already under target",
    }));
    const recordCliCompactionInStore = vi.fn();
    setCliCompactionTestDeps({
      resolveContextEngine: async () => buildContextEngine({ compactCalls }),
      ensureSelectedAgentHarnessPlugin: vi.fn(async () => undefined),
      maybeCompactAgentHarnessSession: compactAgentHarnessSession as never,
      createPreparedEmbeddedAgentSettingsManager: async () => ({
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
      provider: "github-copilot",
      model: "gpt-5.5",
    });

    expect(compactAgentHarnessSession).toHaveBeenCalledTimes(1);
    expect(compactCalls).toHaveLength(0);
    expect(recordCliCompactionInStore).not.toHaveBeenCalled();
    expect(updatedEntry).toBe(sessionEntry);
  });

  it("ignores stale native harness ids when the active provider no longer matches", async () => {
    const sessionKey = "agent:main:openclaw-after-codex";
    const sessionId = "session-openclaw-after-codex";
    const sessionFile = path.join(tmpDir, "session-openclaw-after-codex.jsonl");
    const storePath = path.join(tmpDir, "sessions-openclaw-after-codex.json");
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
      createPreparedEmbeddedAgentSettingsManager: async () => ({
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
      provider: "openclaw",
      model: "sonnet-4.6",
    });

    expect(compactAgentHarnessSession).not.toHaveBeenCalled();
    expect(compactCalls).toHaveLength(1);

    const lockedEntry: SessionEntry = { ...sessionEntry, modelSelectionLocked: true };
    await expect(
      runCliTurnCompactionLifecycle({
        cfg: {} as OpenClawConfig,
        sessionId,
        sessionKey,
        sessionEntry: lockedEntry,
        sessionStore: { [sessionKey]: lockedEntry },
        storePath,
        sessionAgentId: "main",
        workspaceDir: tmpDir,
        agentDir: tmpDir,
        provider: "openclaw",
        model: "sonnet-4.6",
      }),
    ).rejects.toThrow("CLI compaction cannot replace a model-locked native harness runtime");
    expect(compactAgentHarnessSession).not.toHaveBeenCalled();
    expect(compactCalls).toHaveLength(1);
  });

  it("surfaces nonrecoverable native harness CLI compaction failures", async () => {
    const sessionKey = "agent:main:codex-native-failure";
    const sessionId = "session-codex-native-failure";
    const sessionFile = path.join(tmpDir, "session-codex-native-failure.jsonl");
    const storePath = path.join(tmpDir, "sessions-codex-native-failure.json");
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
    const ensureSelectedAgentHarnessPlugin = vi.fn(async () => undefined);
    const compactAgentHarnessSession = vi.fn(async () => ({
      ok: false,
      compacted: false,
      reason: "timed out waiting for codex app-server compaction",
    }));
    const recordCliCompactionInStore = vi.fn();
    setCliCompactionTestDeps({
      resolveContextEngine: async () => buildContextEngine({ compactCalls }),
      ensureSelectedAgentHarnessPlugin,
      maybeCompactAgentHarnessSession: compactAgentHarnessSession as never,
      createPreparedEmbeddedAgentSettingsManager: async () => ({
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
      recordCliCompactionInStore,
    });

    await expect(
      runCliTurnCompactionLifecycle({
        cfg: {} as OpenClawConfig,
        sessionId,
        sessionKey,
        sessionEntry,
        sessionStore,
        storePath,
        sessionAgentId: "main",
        workspaceDir: tmpDir,
        agentDir: tmpDir,
        provider: "codex",
        model: "gpt-5.5",
      }),
    ).rejects.toThrow(
      "CLI native harness compaction failed for codex/gpt-5.5: timed out waiting for codex app-server compaction",
    );

    expect(compactAgentHarnessSession).toHaveBeenCalledTimes(1);
    expect(compactCalls).toHaveLength(0);
    expect(recordCliCompactionInStore).not.toHaveBeenCalled();
  });

  it("falls back to context-engine compaction when Codex owns automatic compaction", async () => {
    const sessionKey = "agent:main:codex-native-auto-compaction";
    const sessionId = "session-codex-native-auto-compaction";
    const sessionFile = path.join(tmpDir, "session-codex-native-auto-compaction.jsonl");
    const storePath = path.join(tmpDir, "sessions-codex-native-auto-compaction.json");
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
    const maintenance = vi.fn(async () => ({ changed: false, bytesFreed: 0, rewrittenEntries: 0 }));
    const compactAgentHarnessSession = vi.fn(async (_params: Record<string, unknown>) => ({
      ok: true,
      compacted: false,
      reason: "codex app-server owns automatic compaction",
      result: {
        summary: "",
        firstKeptEntryId: "",
        tokensBefore: 950,
      },
    }));
    const recordCliCompactionInStore = vi.fn(async () => ({
      ...sessionEntry,
      compactionCount: 1,
    }));
    setCliCompactionTestDeps({
      resolveContextEngine: async () => buildContextEngine({ compactCalls }),
      ensureSelectedAgentHarnessPlugin: vi.fn(async () => undefined),
      maybeCompactAgentHarnessSession: compactAgentHarnessSession as never,
      createPreparedEmbeddedAgentSettingsManager: async () => ({
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

    const result = await runCliTurnCompactionLifecycle({
      cfg: {} as OpenClawConfig,
      sessionId,
      sessionKey,
      sessionEntry,
      sessionStore,
      storePath,
      sessionAgentId: "main",
      workspaceDir: tmpDir,
      agentDir: tmpDir,
      provider: "codex",
      model: "gpt-5.5",
    });

    expect(compactAgentHarnessSession).toHaveBeenCalledTimes(1);
    expect(compactCalls).toHaveLength(1);
    expect(compactCalls[0]?.sessionId).toBe(sessionId);
    expect(compactCalls[0]?.sessionKey).toBe(sessionKey);
    expect(compactCalls[0]?.currentTokenCount).toBe(950);
    expect(maintenance).toHaveBeenCalledTimes(1);
    expect(recordCliCompactionInStore).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "codex",
        sessionKey,
        tokensAfter: undefined,
      }),
    );
    expect(result?.compactionCount).toBe(1);

    const lockedEntry: SessionEntry = { ...sessionEntry, modelSelectionLocked: true };
    sessionStore[sessionKey] = lockedEntry;
    const lockedResult = await runCliTurnCompactionLifecycle({
      cfg: {} as OpenClawConfig,
      sessionId,
      sessionKey,
      sessionEntry: lockedEntry,
      sessionStore,
      storePath,
      sessionAgentId: "main",
      workspaceDir: tmpDir,
      agentDir: tmpDir,
      provider: "codex",
      model: "gpt-5.5",
    });

    expect(compactAgentHarnessSession).toHaveBeenCalledTimes(2);
    expect(compactCalls).toHaveLength(1);
    expect(maintenance).toHaveBeenCalledTimes(1);
    expect(recordCliCompactionInStore).toHaveBeenCalledTimes(1);
    const lockedNativeCall = compactAgentHarnessSession.mock.calls[1]?.[0];
    expect(lockedNativeCall).toMatchObject({
      agentHarnessId: "codex",
      modelSelectionLocked: true,
      contextEngineRuntimeContext: expect.objectContaining({
        agentHarnessId: "codex",
        modelSelectionLocked: true,
        provider: "codex",
        model: "gpt-5.5",
      }),
    });
    expect(lockedResult).toBe(lockedEntry);
  });

  it("does not fall back when native harness compaction returns no result", async () => {
    const sessionKey = "agent:main:codex-native-empty";
    const sessionId = "session-codex-native-empty";
    const sessionFile = path.join(tmpDir, "session-codex-native-empty.jsonl");
    const storePath = path.join(tmpDir, "sessions-codex-native-empty.json");
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
    setCliCompactionTestDeps({
      resolveContextEngine: async () => buildContextEngine({ compactCalls }),
      ensureSelectedAgentHarnessPlugin: vi.fn(async () => undefined),
      maybeCompactAgentHarnessSession: vi.fn(async () => undefined) as never,
      createPreparedEmbeddedAgentSettingsManager: async () => ({
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

    await expect(
      runCliTurnCompactionLifecycle({
        cfg: {} as OpenClawConfig,
        sessionId,
        sessionKey,
        sessionEntry,
        sessionStore,
        storePath,
        sessionAgentId: "main",
        workspaceDir: tmpDir,
        agentDir: tmpDir,
        provider: "codex",
        model: "gpt-5.5",
      }),
    ).rejects.toThrow(
      "CLI native harness compaction failed for codex/gpt-5.5: native harness compaction did not reduce context",
    );
    expect(compactCalls).toHaveLength(0);
  });

  it("passes owning context engines into native harness CLI compaction", async () => {
    const sessionKey = "agent:main:codex-owned-engine";
    const sessionId = "session-codex-owned-engine";
    const sessionFile = path.join(tmpDir, "session-codex-owned-engine.jsonl");
    const storePath = path.join(tmpDir, "sessions-codex-owned-engine.json");
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
    const contextEngine = {
      ...buildContextEngine({ compactCalls }),
      info: {
        id: "lossless-claw",
        name: "Lossless Claw",
        ownsCompaction: true,
      },
    } satisfies ContextEngine;
    const ensureSelectedAgentHarnessPlugin = vi.fn(async () => undefined);
    const compactAgentHarnessSession = vi.fn(async (compactParams) => {
      expect(compactParams.contextEngine).toBe(contextEngine);
      expect(compactParams.contextEngineRuntimeContext).toMatchObject({
        currentTokenCount: 950,
        tokenBudget: 1_000,
        trigger: "cli_native_budget",
      });
      return {
        ok: true,
        compacted: true,
        result: {
          summary: "engine-owned",
          firstKeptEntryId: "entry-1",
          tokensBefore: 950,
          tokensAfter: 42,
          sessionId: "session-codex-owned-engine-rotated",
          sessionFile: path.join(tmpDir, "session-codex-owned-engine-rotated.jsonl"),
        },
      };
    });
    const recordCliCompactionInStore = vi.fn(async () => ({
      ...sessionEntry,
      compactionCount: 1,
    }));
    setCliCompactionTestDeps({
      resolveContextEngine: async () => contextEngine,
      ensureSelectedAgentHarnessPlugin,
      maybeCompactAgentHarnessSession: compactAgentHarnessSession as never,
      createPreparedEmbeddedAgentSettingsManager: async () => ({
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
      recordCliCompactionInStore,
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
      provider: "codex",
      model: "gpt-5.5",
    });

    expect(compactAgentHarnessSession).toHaveBeenCalledTimes(1);
    expect(recordCliCompactionInStore).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "codex",
        sessionKey,
        tokensAfter: 42,
        newSessionId: "session-codex-owned-engine-rotated",
        newSessionFile: path.join(tmpDir, "session-codex-owned-engine-rotated.jsonl"),
      }),
    );
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
      createPreparedEmbeddedAgentSettingsManager: async () => ({
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

  it("falls back to context-engine compaction when Codex native binding is stale", async () => {
    const sessionKey = "agent:main:codex-stale-binding";
    const sessionId = "session-codex-stale-binding";
    const sessionFile = path.join(tmpDir, "session-codex-stale-binding.jsonl");
    const storePath = path.join(tmpDir, "sessions-codex-stale-binding.json");
    await writeSessionFile({ sessionFile, sessionId });

    const sessionEntry: SessionEntry = {
      sessionId,
      updatedAt: Date.now(),
      sessionFile,
      contextTokens: 1_000,
      totalTokens: 950,
      totalTokensFresh: true,
      agentHarnessId: "codex",
      authProfileOverride: "github-copilot:work",
      authProfileOverrideSource: "auto",
    };
    const sessionStore: Record<string, SessionEntry> = { [sessionKey]: sessionEntry };
    await fs.writeFile(storePath, JSON.stringify(sessionStore, null, 2), "utf-8");

    const compactCalls: Array<Parameters<ContextEngine["compact"]>[0]> = [];
    const ensureSelectedAgentHarnessPlugin = vi.fn(async () => undefined);
    const compactAgentHarnessSession = vi.fn(async () => ({
      ok: false,
      compacted: false,
      reason: "thread not found: thread-1",
      failure: {
        reason: "stale_thread_binding",
      },
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
      createPreparedEmbeddedAgentSettingsManager: async () => ({
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
      provider: "codex",
      model: "gpt-5.5",
    });

    expect(compactAgentHarnessSession).toHaveBeenCalledTimes(1);
    expect(compactCalls).toHaveLength(1);
    expect(compactCalls[0]?.runtimeContext).toMatchObject({
      authProfileId: "github-copilot:work",
    });
    expect(maintenance).toHaveBeenCalledTimes(1);
    expect(recordCliCompactionInStore).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "codex",
        sessionKey,
        tokensAfter: undefined,
      }),
    );
    expect(updatedEntry?.compactionCount).toBe(1);
  });

  it("clears stale Codex native binding when context-engine fallback is below target", async () => {
    const sessionKey = "agent:main:codex-stale-binding-under-target";
    const sessionId = "session-codex-stale-binding-under-target";
    const sessionFile = path.join(tmpDir, "session-codex-stale-binding-under-target.jsonl");
    const storePath = path.join(tmpDir, "sessions-codex-stale-binding-under-target.json");
    await writeSessionFile({ sessionFile, sessionId });

    const sessionEntry: SessionEntry = {
      sessionId,
      updatedAt: Date.now(),
      sessionFile,
      contextTokens: 1_000,
      totalTokens: 950,
      totalTokensFresh: true,
      agentHarnessId: "codex",
      cliSessionBindings: {
        codex: { sessionId: "thread-1" },
      },
      cliSessionIds: {
        codex: "thread-1",
      },
    };
    const sessionStore: Record<string, SessionEntry> = { [sessionKey]: sessionEntry };
    await fs.writeFile(storePath, JSON.stringify(sessionStore, null, 2), "utf-8");

    const compactCalls: Array<Parameters<ContextEngine["compact"]>[0]> = [];
    const compactAgentHarnessSession = vi.fn(async () => ({
      ok: false,
      compacted: false,
      reason: "thread not found: thread-1",
      failure: {
        reason: "stale_thread_binding",
      },
    }));
    const maintenance = vi.fn(async () => ({ changed: false, bytesFreed: 0, rewrittenEntries: 0 }));
    const recordCliCompactionInStore = vi.fn();
    setCliCompactionTestDeps({
      resolveContextEngine: async () => ({
        ...buildContextEngine({ compactCalls }),
        async compact(compactParams) {
          compactCalls.push(compactParams);
          return {
            ok: true,
            compacted: false,
            reason: "already under target",
          };
        },
      }),
      ensureSelectedAgentHarnessPlugin: vi.fn(async () => undefined),
      maybeCompactAgentHarnessSession: compactAgentHarnessSession as never,
      createPreparedEmbeddedAgentSettingsManager: async () => ({
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
      provider: "codex",
      model: "gpt-5.5",
    });

    expect(compactAgentHarnessSession).toHaveBeenCalledTimes(1);
    expect(compactCalls).toHaveLength(1);
    expect(maintenance).not.toHaveBeenCalled();
    expect(recordCliCompactionInStore).not.toHaveBeenCalled();
    expect(updatedEntry?.compactionCount).toBeUndefined();
    expect(updatedEntry?.cliSessionBindings?.codex).toBeUndefined();
    expect(updatedEntry?.cliSessionIds?.codex).toBeUndefined();
    expect(sessionStore[sessionKey]?.cliSessionBindings?.codex).toBeUndefined();
    expect(sessionStore[sessionKey]?.cliSessionIds?.codex).toBeUndefined();
  });

  it("falls back to context-engine compaction when Codex native compaction returns a raw missing thread reason", async () => {
    const sessionKey = "agent:main:codex-raw-stale-binding";
    const sessionId = "session-codex-raw-stale-binding";
    const sessionFile = path.join(tmpDir, "session-codex-raw-stale-binding.jsonl");
    const storePath = path.join(tmpDir, "sessions-codex-raw-stale-binding.json");
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
    const compactAgentHarnessSession = vi.fn(async () => ({
      ok: false,
      compacted: false,
      reason: "thread not found: thread-raw",
    }));
    const maintenance = vi.fn(async () => ({ changed: false, bytesFreed: 0, rewrittenEntries: 0 }));
    const recordCliCompactionInStore = vi.fn(async () => ({
      ...sessionEntry,
      compactionCount: 1,
    }));
    setCliCompactionTestDeps({
      resolveContextEngine: async () => buildContextEngine({ compactCalls }),
      ensureSelectedAgentHarnessPlugin: vi.fn(async () => undefined),
      maybeCompactAgentHarnessSession: compactAgentHarnessSession as never,
      createPreparedEmbeddedAgentSettingsManager: async () => ({
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
      provider: "codex",
      model: "gpt-5.5",
    });

    expect(compactAgentHarnessSession).toHaveBeenCalledTimes(1);
    expect(compactCalls).toHaveLength(1);
    expect(maintenance).toHaveBeenCalledTimes(1);
    expect(recordCliCompactionInStore).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "codex",
        sessionKey,
        tokensAfter: undefined,
      }),
    );
    expect(updatedEntry?.compactionCount).toBe(1);
  });

  it("keeps successful context-engine fallback when post-compaction maintenance fails", async () => {
    const sessionKey = "agent:main:codex-stale-maintenance";
    const sessionId = "session-codex-stale-maintenance";
    const sessionFile = path.join(tmpDir, "session-codex-stale-maintenance.jsonl");
    const storePath = path.join(tmpDir, "sessions-codex-stale-maintenance.json");
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
      createPreparedEmbeddedAgentSettingsManager: async () => ({
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
      provider: "codex",
      model: "gpt-5.5",
    });

    expect(compactCalls).toHaveLength(1);
    expect(maintenance).toHaveBeenCalledTimes(1);
    expect(recordCliCompactionInStore).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "codex", sessionKey }),
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
      createPreparedEmbeddedAgentSettingsManager: async () => ({
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
      createPreparedEmbeddedAgentSettingsManager: async () => ({
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

  it("skips compaction when backend declares ownsNativeCompaction and has no harness endpoint", async () => {
    const sessionKey = "agent:main:claude-owns-compaction";
    const sessionId = "session-claude-owns";
    const sessionFile = path.join(tmpDir, "session-claude-owns.jsonl");
    const storePath = path.join(tmpDir, "sessions-claude-owns.json");
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

    const compactCalls: Array<Parameters<ContextEngine["compact"]>[0]> = [];
    const compactAgentHarnessSession = vi.fn();
    const recordCliCompactionInStore = vi.fn();
    setCliCompactionTestDeps({
      resolveContextEngine: async () => buildContextEngine({ compactCalls }),
      maybeCompactAgentHarnessSession: compactAgentHarnessSession as never,
      resolveCliBackendConfig: () => ({
        id: "claude-cli",
        config: { command: "claude" },
        bundleMcp: true,
        ownsNativeCompaction: true,
      }),
      createPreparedEmbeddedAgentSettingsManager: async () => ({
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
      provider: "claude-cli",
      model: "opus",
    });

    expect(compactAgentHarnessSession).not.toHaveBeenCalled();
    expect(compactCalls).toHaveLength(0);
    expect(recordCliCompactionInStore).not.toHaveBeenCalled();
    expect(updatedEntry).toBe(sessionEntry);
  });

  it("does not skip compaction when backend does not declare ownsNativeCompaction", async () => {
    const sessionKey = "agent:main:generic-no-ownership";
    const sessionId = "session-generic";
    const sessionFile = path.join(tmpDir, "session-generic.jsonl");
    const storePath = path.join(tmpDir, "sessions-generic.json");
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

    const compactCalls: Array<Parameters<ContextEngine["compact"]>[0]> = [];
    const maintenance = vi.fn(async () => ({ changed: false, bytesFreed: 0, rewrittenEntries: 0 }));
    setCliCompactionTestDeps({
      resolveContextEngine: async () => buildContextEngine({ compactCalls }),
      resolveCliBackendConfig: () => ({
        id: "generic-backend",
        config: { command: "generic" },
        bundleMcp: false,
      }),
      createPreparedEmbeddedAgentSettingsManager: async () => ({
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
      provider: "generic-backend",
      model: "model",
    });

    expect(compactCalls).toHaveLength(1);
  });

  it("still uses native harness path when backend declares ownsNativeCompaction and has agentHarnessId", async () => {
    const sessionKey = "agent:main:codex-with-ownership";
    const sessionId = "session-codex-ownership";
    const sessionFile = path.join(tmpDir, "session-codex-ownership.jsonl");
    const storePath = path.join(tmpDir, "sessions-codex-ownership.json");
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
    const contextEngine = buildContextEngine({ compactCalls });
    const compactAgentHarnessSession = vi.fn(async () => ({
      ok: true,
      compacted: true,
      result: { tokensBefore: 950, tokensAfter: 100 },
    }));
    const recordCliCompactionInStore = vi.fn(async () => ({
      ...sessionEntry,
      compactionCount: 1,
    }));
    setCliCompactionTestDeps({
      resolveContextEngine: async () => contextEngine,
      ensureSelectedAgentHarnessPlugin: vi.fn(async () => undefined),
      maybeCompactAgentHarnessSession: compactAgentHarnessSession as never,
      resolveCliBackendConfig: () => ({
        id: "codex",
        config: { command: "codex" },
        bundleMcp: false,
        ownsNativeCompaction: true,
      }),
      createPreparedEmbeddedAgentSettingsManager: async () => ({
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
      applyAgentAutoCompactionGuard: vi.fn(async () => ({ supported: true, disabled: false })),
      recordCliCompactionInStore,
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
      provider: "openai",
      model: "gpt-5.5",
    });

    expect(compactAgentHarnessSession).toHaveBeenCalledTimes(1);
    expect(compactCalls).toHaveLength(0);
    expect(recordCliCompactionInStore).toHaveBeenCalledTimes(1);
  });
});
