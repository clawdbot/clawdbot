// Covers CLI turn compaction lifecycle and external CLI resume-state cleanup.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { CURRENT_SESSION_VERSION } from "openclaw/plugin-sdk/agent-sessions";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import { SESSION_TOTAL_TOKENS_VERSION, type SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ContextEngine } from "../../context-engine/types.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import { withEnv } from "../../test-utils/env.js";
import { resolveCliBackendConfig } from "../cli-backends.js";
import { createModelGenerationFixture } from "../embedded-agent-runner/model.generation-scope.test-support.js";
import { SessionManager } from "../sessions/session-manager.js";
import { cliCompactionBackendEntrypoints } from "./cli-compaction-runtime.test-support.js";
import {
  resetCliCompactionTestDeps,
  runCliTurnCompactionLifecycle,
  setCliCompactionTestDeps,
} from "./cli-compaction.js";
import { recordCliCompactionInStore as recordCliCompactionInStoreImpl } from "./session-store.js";

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

async function persistSessionEntry(params: {
  sessionKey: string;
  storePath: string;
  entry: SessionEntry;
}) {
  await replaceSessionEntry(
    {
      sessionKey: params.sessionKey,
      storePath: params.storePath,
    },
    params.entry,
  );
}

type CliCompactionTestDeps = Parameters<typeof setCliCompactionTestDeps>[0];
type CliCompactionParams = Parameters<typeof runCliTurnCompactionLifecycle>[0];
type CompactParams = Parameters<ContextEngine["compact"]>[0];

const defaultSettingsManager = async () => ({
  getCompactionReserveTokens: () => 200,
  getCompactionKeepRecentTokens: () => 0,
  applyOverrides: () => {},
});

const defaultPreemptiveCompaction = () => ({
  route: "fits" as const,
  shouldCompact: false,
  estimatedPromptTokens: 600,
  promptBudgetBeforeReserve: 800,
  overflowTokens: 0,
  toolResultReducibleChars: 0,
  effectiveReserveTokens: 200,
});

function createPreparedRuntimeLease(input: {
  config: OpenClawConfig;
  agentDir: string;
  agentId?: string;
  workspaceDir?: string;
}) {
  const prepared = createModelGenerationFixture({
    config: input.config,
    label: "cli",
    agentDir: input.agentDir,
    workspaceDir: expectDefined(input.workspaceDir, "compaction fixture workspace"),
  });
  return {
    snapshot: {
      ...prepared.preparedModelRuntime,
      ...(input.agentId ? { agentId: input.agentId } : {}),
    },
    pluginGeneration: {
      configuredCatalogEntries: [],
      inlineProviderModels: [],
      pluginMetadataSnapshot: prepared.metadataSnapshot,
      pluginRegistry: prepared.pluginRegistry,
    },
    release: vi.fn(),
  };
}

async function prepareCompactionScenario(params: {
  tmpDir: string;
  suffix: string;
  provider?: string;
  model?: string;
  sessionKey?: string;
  sessionId?: string;
  sessionEntry?: Partial<SessionEntry>;
  cfg?: OpenClawConfig;
  cwd?: string;
  contextEngine?: (compactCalls: CompactParams[]) => ContextEngine;
  maintenance?: CliCompactionTestDeps["runContextEngineMaintenance"];
  recordCliCompactionInStore?: CliCompactionTestDeps["recordCliCompactionInStore"];
  deps?: CliCompactionTestDeps;
}) {
  const sessionKey = params.sessionKey ?? `agent:main:${params.suffix}`;
  const sessionId = params.sessionId ?? `session-${params.suffix}`;
  const transcriptFile = path.join(params.tmpDir, `${params.suffix}.jsonl`);
  const storePath = path.join(params.tmpDir, `${params.suffix}.sqlite`);
  await writeSessionFile({ sessionFile: transcriptFile, sessionId });

  const sessionEntry: SessionEntry = {
    sessionId,
    updatedAt: Date.now(),
    sessionFile: transcriptFile,
    contextTokens: 1_000,
    totalTokens: 950,
    totalTokensFresh: true,
    totalTokensVersion: SESSION_TOTAL_TOKENS_VERSION,
    ...params.sessionEntry,
  };
  const sessionStore: Record<string, SessionEntry> = { [sessionKey]: sessionEntry };
  await persistSessionEntry({ sessionKey, storePath, entry: sessionEntry });

  const compactCalls: CompactParams[] = [];
  const contextEngine =
    params.contextEngine?.(compactCalls) ?? buildContextEngine({ compactCalls });
  const maintenance = vi.fn(
    params.maintenance ?? (async () => ({ changed: false, bytesFreed: 0, rewrittenEntries: 0 })),
  );
  const recordCliCompactionInStore =
    params.recordCliCompactionInStore ?? vi.fn(recordCliCompactionInStoreImpl);
  setCliCompactionTestDeps({
    resolveContextEngine: async () => contextEngine,
    ensureSelectedAgentHarnessPlugin: vi.fn(async () => undefined),
    createPreparedEmbeddedAgentSettingsManager: defaultSettingsManager,
    shouldPreemptivelyCompactBeforePrompt: defaultPreemptiveCompaction,
    resolveLiveToolResultMaxChars: () => 20_000,
    runContextEngineMaintenance: maintenance,
    recordCliCompactionInStore,
    ...params.deps,
  });

  const runParams: CliCompactionParams = {
    cfg: params.cfg ?? ({} as OpenClawConfig),
    sessionId,
    sessionKey,
    sessionEntry,
    sessionStore,
    storePath,
    sessionAgentId: "main",
    workspaceDir: params.tmpDir,
    cwd: params.cwd,
    agentDir: params.tmpDir,
    provider: params.provider ?? "claude-cli",
    model: params.model ?? "opus",
  };
  return {
    compactCalls,
    contextEngine,
    maintenance,
    recordCliCompactionInStore,
    run: (overrides: Partial<CliCompactionParams> = {}) =>
      runCliTurnCompactionLifecycle({ ...runParams, ...overrides }),
    sessionEntry,
    sessionId,
    sessionKey,
    sessionStore,
    storePath,
    transcriptFile,
  };
}

async function prepareContextSuccessorScenario(params: {
  result: (target: {
    sessionKey: string;
    sessionId: string;
    storePath: string;
  }) =>
    | Awaited<ReturnType<ContextEngine["compact"]>>
    | Promise<Awaited<ReturnType<ContextEngine["compact"]>>>;
  suffix: string;
  tmpDir: string;
}) {
  return prepareCompactionScenario({
    suffix: `cli-successor-${params.suffix}`,
    tmpDir: params.tmpDir,
    contextEngine: () => ({
      ...buildContextEngine({ compactCalls: [] }),
      async compact() {
        const sessionKey = `agent:main:cli-successor-${params.suffix}`;
        const sessionId = `session-cli-successor-${params.suffix}`;
        const storePath = path.join(params.tmpDir, `cli-successor-${params.suffix}.sqlite`);
        return params.result({ sessionId, sessionKey, storePath });
      },
    }),
    recordCliCompactionInStore: vi.fn(
      async ({ sessionKey, sessionStore }) => sessionStore[sessionKey],
    ),
  });
}

describe("runCliTurnCompactionLifecycle", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cli-compaction-"));
    setCliCompactionTestDeps({
      resolveCliBackendConfig: () => null,
      acquirePreparedModelRuntime: async (input) => createPreparedRuntimeLease(input),
    });
  });

  afterEach(async () => {
    resetCliCompactionTestDeps();
    vi.clearAllTimers();
    vi.useRealTimers();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("ignores an unversioned fresh total on the first upgraded turn", async () => {
    const scenario = await prepareCompactionScenario({
      suffix: "legacy-unversioned-total",
      tmpDir,
      sessionEntry: { totalTokens: 950, totalTokensFresh: true, totalTokensVersion: undefined },
    });

    const updatedEntry = await scenario.run();

    expect(scenario.compactCalls).toEqual([]);
    expect(updatedEntry).toBe(scenario.sessionEntry);
  });

  it("accepts no compactable entries only from a successful compaction result", async () => {
    let result = { ok: true, compacted: false, reason: "no real conversation messages" };
    const scenario = await prepareCompactionScenario({
      suffix: "no-compactable-entries",
      tmpDir,
      provider: "test-provider",
      model: "test-model",
      contextEngine: () => ({
        ...buildContextEngine({ compactCalls: [] }),
        async compact() {
          return result;
        },
      }),
      deps: {
        openSessionManager: () =>
          ({ getBranch: () => [], buildSessionContext: () => ({ messages: [] }) }) as never,
      },
    });
    const runLifecycle = (
      ok: boolean,
      reason = "no real conversation messages",
      compacted = false,
    ) => {
      result = { ok, compacted, reason };
      return scenario.run();
    };

    await expect(runLifecycle(true)).resolves.toBe(scenario.sessionEntry);
    await expect(runLifecycle(false)).rejects.toThrow(
      "CLI transcript compaction failed for test-provider/test-model: no real conversation messages",
    );
    await expect(runLifecycle(false, "already under target")).resolves.toBe(scenario.sessionEntry);
    await expect(runLifecycle(false, "contradictory result", true)).rejects.toThrow(
      "CLI transcript compaction failed for test-provider/test-model: contradictory result",
    );
  });

  it("compacts over-budget CLI transcripts and clears external CLI resume state", async () => {
    const taskCwd = path.join(tmpDir, "task-repo");
    await fs.mkdir(taskCwd, { recursive: true });
    const settingsCwds: string[] = [];
    // Compaction settings should be resolved against the task cwd, not the
    // bootstrap workspace, because CLI prompts may run from nested repos.
    const scenario = await prepareCompactionScenario({
      suffix: "cli",
      tmpDir,
      sessionKey: "agent:main:cli",
      cwd: taskCwd,
      sessionEntry: {
        sessionFile: "agent:main:cli",
        cliSessionBindings: { "claude-cli": { sessionId: "claude-session" } },
        cliSessionIds: { "claude-cli": "claude-session" },
        claudeCliSessionId: "claude-session",
      },
      deps: {
        createPreparedEmbeddedAgentSettingsManager: async (params) => {
          settingsCwds.push(params.cwd);
          return defaultSettingsManager();
        },
      },
    });
    const { compactCalls, maintenance, sessionId, sessionKey, storePath } = scenario;
    const updatedEntry = await scenario.run();

    expect(compactCalls).toHaveLength(1);
    const compactCall = compactCalls[0];
    expect(compactCall?.sessionId).toBe(sessionId);
    expect(compactCall?.sessionKey).toBe(sessionKey);
    expect(compactCall?.sessionTarget).toEqual({ sessionId, sessionKey, storePath });
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
    expect(maintenanceCall?.sessionFile).toBe(sessionKey);
    expect(updatedEntry?.compactionCount).toBe(1);
    // Once OpenClaw rewrites the transcript, external CLI resume ids are stale
    // and must be cleared so the next turn starts from the compacted prompt.
    expect(updatedEntry?.cliSessionBindings?.["claude-cli"]).toBeUndefined();
    expect(updatedEntry?.cliSessionIds?.["claude-cli"]).toBeUndefined();
    expect(updatedEntry?.claudeCliSessionId).toBeUndefined();
  });

  it("records context-engine compaction successor session targets", async () => {
    const successorSessionId = "session-cli-rotated";
    const recordCliCompactionInStore = vi.fn(recordCliCompactionInStoreImpl);
    const scenario = await prepareCompactionScenario({
      suffix: "cli-rotates",
      tmpDir,
      contextEngine: (compactCalls) => ({
        ...buildContextEngine({ compactCalls }),
        async compact(compactParams) {
          compactCalls.push(compactParams);
          return {
            ok: true,
            compacted: true,
            result: {
              summary: "compacted",
              tokensBefore: compactParams.currentTokenCount ?? 0,
              tokensAfter: 100,
              sessionId: successorSessionId,
              sessionTarget: {
                sessionKey: "agent:main:cli-rotates",
                storePath: path.join(tmpDir, "cli-rotates.sqlite"),
              },
            },
          };
        },
      }),
      recordCliCompactionInStore,
    });
    const { compactCalls, maintenance, sessionId, sessionKey, storePath } = scenario;
    await scenario.run();

    expect(compactCalls[0]?.sessionTarget).toEqual({ sessionId, sessionKey, storePath });
    expect(maintenance).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: successorSessionId,
        sessionFile: sessionKey,
      }),
    );
    expect(recordCliCompactionInStore).toHaveBeenCalledWith(
      expect.objectContaining({
        compactionKind: "context-engine",
        expectedSession: expect.objectContaining({ sessionId: successorSessionId }),
        tokensAfter: 100,
      }),
    );
  });

  it("preserves deprecated SQLite-marker successors during CLI maintenance", async () => {
    const successorId = "session-cli-marker-successor";
    const scenario = await prepareContextSuccessorScenario({
      suffix: "marker",
      tmpDir,
      result: ({ storePath }) => ({
        ok: true,
        compacted: true,
        result: {
          tokensBefore: 950,
          tokensAfter: 100,
          sessionId: successorId,
          sessionFile: `sqlite:main:${successorId}:${storePath}`,
        },
      }),
    });

    await scenario.run();

    expect(scenario.maintenance).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionFile: `sqlite:main:${successorId}:${scenario.storePath}`,
        sessionId: successorId,
        sessionTarget: {
          agentId: "main",
          sessionId: successorId,
          sessionKey: scenario.sessionKey,
          storePath: scenario.storePath,
        },
      }),
    );
    expect(scenario.recordCliCompactionInStore).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedSession: expect.objectContaining({ sessionId: successorId }),
      }),
    );
  });

  it("rejects an engine that changes the host row before successor acceptance", async () => {
    const successorId = "session-cli-key-successor";
    const scenario = await prepareContextSuccessorScenario({
      suffix: "session-key",
      tmpDir,
      result: async ({ sessionKey, storePath }) => {
        await persistSessionEntry({
          sessionKey,
          storePath,
          entry: { sessionId: successorId, updatedAt: Date.now() },
        });
        return {
          ok: true,
          compacted: true,
          result: {
            tokensBefore: 950,
            sessionId: successorId,
            sessionFile: sessionKey,
          },
        };
      },
    });

    await expect(scenario.run()).rejects.toThrow();
    expect(scenario.maintenance).not.toHaveBeenCalled();
    expect(scenario.recordCliCompactionInStore).not.toHaveBeenCalled();
  });

  it("rejects conflicting CLI successor ids", async () => {
    const scenario = await prepareContextSuccessorScenario({
      suffix: "conflicting-ids",
      tmpDir,
      result: ({ sessionKey, storePath }) => ({
        ok: true,
        compacted: true,
        result: {
          tokensBefore: 950,
          sessionId: "reported-successor",
          sessionTarget: {
            agentId: "main",
            sessionId: "target-successor",
            sessionKey,
            storePath,
          },
        },
      }),
    });

    await expect(scenario.run()).rejects.toThrow("successor identity is inconsistent");
  });

  it.each([
    ["agent", () => ({ agentId: "other" })],
    ["session key", () => ({ sessionKey: "agent:main:other" })],
    ["store", () => ({ storePath: path.join(tmpDir, "other-openclaw-sessions.sqlite") })],
  ])("rejects a CLI successor outside the active %s binding", async (label, buildOverride) => {
    const scenario = await prepareContextSuccessorScenario({
      suffix: `outside-${label.replace(" ", "-")}`,
      tmpDir,
      result: ({ sessionKey, storePath }) => ({
        ok: true,
        compacted: true,
        result: {
          tokensBefore: 950,
          sessionTarget: {
            agentId: "main",
            sessionId: "outside-successor",
            sessionKey,
            storePath,
            ...buildOverride(),
          },
        },
      }),
    });

    await expect(scenario.run()).rejects.toThrow(
      "successor target changed the active session binding",
    );
  });

  it("treats below-target CLI transcript compaction as a no-op", async () => {
    const scenario = await prepareCompactionScenario({
      suffix: "cli-under-target",
      tmpDir,
      sessionEntry: {
        sessionFile: "agent:main:cli-under-target",
        cliSessionBindings: { "claude-cli": { sessionId: "claude-session" } },
      },
      contextEngine: (compactCalls) => ({
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
    });
    const { compactCalls, maintenance, recordCliCompactionInStore, sessionEntry } = scenario;
    const updatedEntry = await scenario.run();

    expect(compactCalls).toHaveLength(1);
    expect(maintenance).not.toHaveBeenCalled();
    expect(recordCliCompactionInStore).not.toHaveBeenCalled();
    expect(updatedEntry).toBe(sessionEntry);
    expect(
      scenario.sessionStore[scenario.sessionKey]?.cliSessionBindings?.["claude-cli"]?.sessionId,
    ).toBe("claude-session");
  });

  it("treats already-compacted CLI transcript compaction as a no-op", async () => {
    const scenario = await prepareCompactionScenario({
      suffix: "qwen-already-compacted",
      tmpDir,
      provider: "ollama",
      model: "qwen3:14b",
      contextEngine: (compactCalls) => ({
        ...buildContextEngine({ compactCalls }),
        async compact(compactParams) {
          compactCalls.push(compactParams);
          throw new Error("Already compacted");
        },
      }),
    });
    const { compactCalls, maintenance, recordCliCompactionInStore, sessionEntry } = scenario;
    const updatedEntry = await scenario.run();

    expect(compactCalls).toHaveLength(1);
    expect(maintenance).not.toHaveBeenCalled();
    expect(recordCliCompactionInStore).not.toHaveBeenCalled();
    expect(updatedEntry).toBe(sessionEntry);
  });

  it("routes OpenAI Codex harness CLI compaction through native harness compaction", async () => {
    const compactCalls: CompactParams[] = [];
    const contextEngine = buildContextEngine({ compactCalls });
    const resolveContextEngine = vi.fn(async () => contextEngine);
    const preparedRuntimeLease = createPreparedRuntimeLease({
      config: {},
      agentId: "main",
      agentDir: tmpDir,
      workspaceDir: tmpDir,
    });
    const pluginGeneration = {
      configuredCatalogEntries: [],
      inlineProviderModels: [],
      pluginMetadataSnapshot: preparedRuntimeLease.snapshot.metadataSnapshot,
      pluginRegistry: preparedRuntimeLease.snapshot.pluginRegistry,
    } as never;
    const acquirePreparedModelRuntime = vi.fn<
      NonNullable<CliCompactionTestDeps["acquirePreparedModelRuntime"]>
    >(async (_input, options) => {
      expect(options?.pluginGeneration).toBe(pluginGeneration);
      return preparedRuntimeLease;
    });
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
      sessionId: "session-codex",
      updatedAt: Date.now(),
      compactionCount: 1,
    }));
    const scenario = await prepareCompactionScenario({
      suffix: "codex",
      tmpDir,
      provider: "openai",
      model: "gpt-5.5",
      sessionEntry: {
        agentHarnessId: "codex",
        modelSelectionLocked: true,
        authProfileOverride: "github-copilot:work",
        authProfileOverrideSource: "auto",
      },
      recordCliCompactionInStore,
      deps: {
        resolveContextEngine,
        acquirePreparedModelRuntime,
        ensureSelectedAgentHarnessPlugin,
        maybeCompactAgentHarnessSession: compactAgentHarnessSession as never,
        applyAgentAutoCompactionGuard,
      },
    });
    const { sessionId, sessionKey } = scenario;
    const updatedEntry = await scenario.run({ pluginGeneration });

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
        pluginRegistry: preparedRuntimeLease.snapshot.pluginRegistry,
      }),
    );
    expect(acquirePreparedModelRuntime).toHaveBeenCalledOnce();
    expect(applyAgentAutoCompactionGuard.mock.invocationCallOrder[0] ?? 0).toBeLessThan(
      compactAgentHarnessSession.mock.invocationCallOrder[0] ?? 0,
    );
    expect(compactAgentHarnessSession).toHaveBeenCalledTimes(1);
    const compactAgentHarnessSessionCalls = compactAgentHarnessSession.mock
      .calls as unknown as Array<[Record<string, unknown>, { preparedModelRuntime?: unknown }]>;
    expect(compactAgentHarnessSessionCalls[0]?.[0]).toMatchObject({
      sessionId,
      sessionKey,
      sessionFile: sessionKey,
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
    expect(compactAgentHarnessSessionCalls[0]?.[1]?.preparedModelRuntime).toBe(
      preparedRuntimeLease.snapshot,
    );
    expect(preparedRuntimeLease.release).toHaveBeenCalledOnce();
    expect(compactCalls).toHaveLength(0);
    expect(recordCliCompactionInStore).toHaveBeenCalledTimes(1);
    expect(recordCliCompactionInStore).toHaveBeenCalledWith(
      expect.objectContaining({
        compactionKind: "native-harness",
        sessionKey,
        tokensAfter: 100,
      }),
    );
    expect(updatedEntry?.compactionCount).toBe(1);
  });

  it("treats below-target Copilot native CLI compaction as a no-op", async () => {
    const compactAgentHarnessSession = vi.fn(async () => ({
      ok: true,
      compacted: false,
      reason: "already under target",
    }));
    const scenario = await prepareCompactionScenario({
      suffix: "copilot-under-target",
      tmpDir,
      provider: "github-copilot",
      model: "gpt-5.5",
      sessionEntry: { agentHarnessId: "copilot" },
      deps: { maybeCompactAgentHarnessSession: compactAgentHarnessSession as never },
    });
    const { compactCalls, recordCliCompactionInStore, sessionEntry } = scenario;
    const updatedEntry = await scenario.run();

    expect(compactAgentHarnessSession).toHaveBeenCalledTimes(1);
    expect(compactCalls).toHaveLength(0);
    expect(recordCliCompactionInStore).not.toHaveBeenCalled();
    expect(updatedEntry).toBe(sessionEntry);
  });

  it("ignores stale native harness ids when the active provider no longer matches", async () => {
    const compactAgentHarnessSession = vi.fn();
    const scenario = await prepareCompactionScenario({
      suffix: "openclaw-after-codex",
      tmpDir,
      provider: "openclaw",
      model: "sonnet-4.6",
      sessionEntry: { agentHarnessId: "codex" },
      deps: { maybeCompactAgentHarnessSession: compactAgentHarnessSession as never },
    });
    const { compactCalls, sessionEntry, sessionKey } = scenario;
    await scenario.run();

    expect(compactAgentHarnessSession).not.toHaveBeenCalled();
    expect(compactCalls).toHaveLength(1);

    const lockedEntry: SessionEntry = { ...sessionEntry, modelSelectionLocked: true };
    await expect(
      scenario.run({ sessionEntry: lockedEntry, sessionStore: { [sessionKey]: lockedEntry } }),
    ).rejects.toThrow("CLI compaction cannot replace a model-locked native harness runtime");
    expect(compactAgentHarnessSession).not.toHaveBeenCalled();
    expect(compactCalls).toHaveLength(1);
  });

  it.each([
    {
      name: "a normal failed result",
      compacted: false,
      reason: "timed out waiting for codex app-server compaction",
    },
    {
      name: "a contradictory compacted failure",
      compacted: true,
      reason: "contradictory native result",
    },
  ])("surfaces nonrecoverable native harness CLI compaction failures for $name", async (result) => {
    const ensureSelectedAgentHarnessPlugin = vi.fn(async () => undefined);
    const compactAgentHarnessSession = vi.fn(async () => ({
      ok: false,
      compacted: result.compacted,
      reason: result.reason,
    }));
    const scenario = await prepareCompactionScenario({
      suffix: "codex-native-failure",
      tmpDir,
      provider: "codex",
      model: "gpt-5.5",
      sessionEntry: { agentHarnessId: "codex" },
      deps: {
        ensureSelectedAgentHarnessPlugin,
        maybeCompactAgentHarnessSession: compactAgentHarnessSession as never,
      },
    });
    const { compactCalls, recordCliCompactionInStore } = scenario;

    await expect(scenario.run()).rejects.toThrow(
      `CLI native harness compaction failed for codex/gpt-5.5: ${result.reason}`,
    );

    expect(compactAgentHarnessSession).toHaveBeenCalledTimes(1);
    expect(compactCalls).toHaveLength(0);
    expect(recordCliCompactionInStore).not.toHaveBeenCalled();
  });

  it("skips context-engine fallback when Codex owns automatic compaction", async () => {
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
    const scenario = await prepareCompactionScenario({
      suffix: "codex-native-auto-compaction",
      tmpDir,
      provider: "codex",
      model: "gpt-5.5",
      sessionEntry: { agentHarnessId: "codex" },
      deps: { maybeCompactAgentHarnessSession: compactAgentHarnessSession as never },
    });
    const { compactCalls, recordCliCompactionInStore, sessionEntry, sessionKey, sessionStore } =
      scenario;
    const result = await scenario.run();

    // Codex owns automatic compaction; the ownership skip must not fall back to
    // context-engine compaction (OAuth-only sessions have no direct API key).
    expect(compactAgentHarnessSession).toHaveBeenCalledTimes(1);
    expect(compactCalls).toHaveLength(0);
    expect(recordCliCompactionInStore).not.toHaveBeenCalled();
    expect(result).toBe(sessionEntry);

    const lockedEntry: SessionEntry = { ...sessionEntry, modelSelectionLocked: true };
    sessionStore[sessionKey] = lockedEntry;
    const lockedResult = await scenario.run({ sessionEntry: lockedEntry });

    expect(compactAgentHarnessSession).toHaveBeenCalledTimes(2);
    expect(compactCalls).toHaveLength(0);
    expect(recordCliCompactionInStore).not.toHaveBeenCalled();
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
    const scenario = await prepareCompactionScenario({
      suffix: "codex-native-empty",
      tmpDir,
      provider: "codex",
      model: "gpt-5.5",
      sessionEntry: { agentHarnessId: "codex" },
      deps: { maybeCompactAgentHarnessSession: vi.fn(async () => undefined) as never },
    });

    await expect(scenario.run()).rejects.toThrow(
      "CLI native harness compaction failed for codex/gpt-5.5: native harness compaction did not reduce context",
    );
    expect(scenario.compactCalls).toHaveLength(0);
  });

  it("does not interpret a native harness result id as a host successor", async () => {
    const compactCalls: CompactParams[] = [];
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
      sessionId: "session-codex-owned-engine",
      updatedAt: Date.now(),
      compactionCount: 1,
    }));
    const scenario = await prepareCompactionScenario({
      suffix: "codex-owned-engine",
      tmpDir,
      provider: "codex",
      model: "gpt-5.5",
      sessionEntry: { agentHarnessId: "codex" },
      recordCliCompactionInStore,
      deps: {
        resolveContextEngine: async () => contextEngine,
        ensureSelectedAgentHarnessPlugin,
        maybeCompactAgentHarnessSession: compactAgentHarnessSession as never,
      },
    });
    const { sessionKey } = scenario;
    await scenario.run();

    expect(compactAgentHarnessSession).toHaveBeenCalledTimes(1);
    expect(recordCliCompactionInStore).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey,
        tokensAfter: 42,
        expectedSession: expect.objectContaining({ sessionId: "session-codex-owned-engine" }),
      }),
    );
  });

  it("falls back to context-engine compaction when a pinned harness has no native compactor", async () => {
    const ensureSelectedAgentHarnessPlugin = vi.fn(async () => undefined);
    const compactAgentHarnessSession = vi.fn(async () => ({
      ok: false,
      compacted: false,
      reason: 'Agent harness "external-harness" does not support compaction.',
      failure: { reason: "unsupported_harness_compaction" },
    }));
    const scenario = await prepareCompactionScenario({
      suffix: "external-harness",
      tmpDir,
      provider: "external-harness",
      model: "model",
      sessionEntry: { agentHarnessId: "external-harness" },
      deps: {
        ensureSelectedAgentHarnessPlugin,
        maybeCompactAgentHarnessSession: compactAgentHarnessSession as never,
      },
    });
    const { compactCalls, maintenance, recordCliCompactionInStore, sessionKey } = scenario;
    const updatedEntry = await scenario.run();

    expect(compactAgentHarnessSession).toHaveBeenCalledTimes(1);
    expect(compactCalls).toHaveLength(1);
    expect(maintenance).toHaveBeenCalledTimes(1);
    expect(recordCliCompactionInStore).toHaveBeenCalledWith(
      expect.objectContaining({
        compactionKind: "context-engine",
        sessionKey,
        tokensAfter: 100,
      }),
    );
    expect(updatedEntry?.compactionCount).toBe(1);
  });

  it("falls back to context-engine compaction when Codex native binding is stale", async () => {
    const ensureSelectedAgentHarnessPlugin = vi.fn(async () => undefined);
    const compactAgentHarnessSession = vi.fn(async () => ({
      ok: false,
      compacted: false,
      reason: "thread not found: thread-1",
      failure: {
        reason: "stale_thread_binding",
      },
    }));
    const scenario = await prepareCompactionScenario({
      suffix: "codex-stale-binding",
      tmpDir,
      provider: "codex",
      model: "gpt-5.5",
      sessionEntry: {
        agentHarnessId: "codex",
        authProfileOverride: "github-copilot:work",
        authProfileOverrideSource: "auto",
      },
      deps: {
        ensureSelectedAgentHarnessPlugin,
        maybeCompactAgentHarnessSession: compactAgentHarnessSession as never,
      },
    });
    const { compactCalls, maintenance, recordCliCompactionInStore, sessionKey } = scenario;
    const updatedEntry = await scenario.run();

    expect(compactAgentHarnessSession).toHaveBeenCalledTimes(1);
    expect(compactCalls).toHaveLength(1);
    expect(compactCalls[0]?.runtimeContext).toMatchObject({
      authProfileId: "github-copilot:work",
    });
    expect(maintenance).toHaveBeenCalledTimes(1);
    expect(recordCliCompactionInStore).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey,
        tokensAfter: 100,
      }),
    );
    expect(updatedEntry?.compactionCount).toBe(1);
  });

  it("clears stale Codex native binding when context-engine fallback is below target", async () => {
    const compactAgentHarnessSession = vi.fn(async () => ({
      ok: false,
      compacted: false,
      reason: "thread not found: thread-1",
      failure: {
        reason: "stale_thread_binding",
      },
    }));
    const scenario = await prepareCompactionScenario({
      suffix: "codex-stale-binding-under-target",
      tmpDir,
      provider: "codex",
      model: "gpt-5.5",
      sessionEntry: {
        agentHarnessId: "codex",
        cliSessionBindings: { codex: { sessionId: "thread-1" } },
        cliSessionIds: { codex: "thread-1" },
      },
      contextEngine: (compactCalls) => ({
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
      deps: { maybeCompactAgentHarnessSession: compactAgentHarnessSession as never },
    });
    const { compactCalls, maintenance, recordCliCompactionInStore, sessionKey, sessionStore } =
      scenario;
    const updatedEntry = await scenario.run();

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
    const compactAgentHarnessSession = vi.fn(async () => ({
      ok: false,
      compacted: false,
      reason: "thread not found: thread-raw",
    }));
    const scenario = await prepareCompactionScenario({
      suffix: "codex-raw-stale-binding",
      tmpDir,
      provider: "codex",
      model: "gpt-5.5",
      sessionEntry: { agentHarnessId: "codex" },
      deps: { maybeCompactAgentHarnessSession: compactAgentHarnessSession as never },
    });
    const { compactCalls, maintenance, recordCliCompactionInStore, sessionKey } = scenario;
    const updatedEntry = await scenario.run();

    expect(compactAgentHarnessSession).toHaveBeenCalledTimes(1);
    expect(compactCalls).toHaveLength(1);
    expect(maintenance).toHaveBeenCalledTimes(1);
    expect(recordCliCompactionInStore).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey,
        tokensAfter: 100,
      }),
    );
    expect(updatedEntry?.compactionCount).toBe(1);
  });

  it("keeps successful context-engine fallback when post-compaction maintenance fails", async () => {
    const maintenance = vi.fn(async () => {
      throw new Error("maintenance rotated stale binding");
    });
    const scenario = await prepareCompactionScenario({
      suffix: "codex-stale-maintenance",
      tmpDir,
      provider: "codex",
      model: "gpt-5.5",
      sessionEntry: { agentHarnessId: "codex" },
      maintenance,
      deps: {
        maybeCompactAgentHarnessSession: vi.fn(async () => ({
          ok: false,
          compacted: false,
          reason: "thread not found: thread-1",
          failure: { reason: "stale_thread_binding" },
        })) as never,
      },
    });
    const { compactCalls, recordCliCompactionInStore, sessionKey } = scenario;
    const updatedEntry = await scenario.run();

    expect(compactCalls).toHaveLength(1);
    expect(maintenance).toHaveBeenCalledTimes(1);
    expect(recordCliCompactionInStore).toHaveBeenCalledWith(
      expect.objectContaining({ sessionKey }),
    );
    expect(updatedEntry?.compactionCount).toBe(1);
  });

  it("initializes built-in context engines before resolving CLI compaction engine", async () => {
    const calls: string[] = [];
    const scenario = await prepareCompactionScenario({
      suffix: "cli-init",
      tmpDir,
      sessionKey: "agent:main:cli",
      sessionEntry: { sessionFile: undefined },
      deps: {
        ensureContextEnginesInitialized: () => {
          calls.push("ensure");
        },
        resolveContextEngine: async () => {
          calls.push("resolve");
          return buildContextEngine({ compactCalls: [] });
        },
      },
    });
    await scenario.run();

    expect(calls).toEqual(["ensure", "resolve"]);
  });

  it("bounds a hung CLI context-engine compaction and leaves resume state intact", async () => {
    const scenario = await prepareCompactionScenario({
      suffix: "cli-timeout",
      tmpDir,
      sessionKey: "agent:main:cli",
      cfg: { agents: { defaults: { compaction: { timeoutSeconds: 1 } } } } as OpenClawConfig,
      sessionEntry: {
        cliSessionBindings: { "claude-cli": { sessionId: "claude-session" } },
        cliSessionIds: { "claude-cli": "claude-session" },
        claudeCliSessionId: "claude-session",
      },
      contextEngine: (compactCalls) => ({
        ...buildContextEngine({ compactCalls }),
        async compact(compactParams) {
          compactCalls.push(compactParams);
          return await new Promise(() => {});
        },
      }),
    });
    const { compactCalls, maintenance, recordCliCompactionInStore, sessionKey, sessionStore } =
      scenario;

    vi.useFakeTimers();
    const pending = scenario.run();

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

  it.each(cliCompactionBackendEntrypoints.map((entry) => [entry.provider, entry] as const))(
    "preserves %s native history and resume binding under compaction pressure",
    async (provider, entry) => {
      const { pluginId } = entry;
      const bundled = path.join(tmpDir, "bundled");
      const pluginRoot = path.join(bundled, pluginId);
      await fs.mkdir(pluginRoot, { recursive: true });
      await fs.copyFile(
        new URL(`../../../extensions/${pluginId}/openclaw.plugin.json`, import.meta.url),
        path.join(pluginRoot, "openclaw.plugin.json"),
      );
      await fs.writeFile(
        path.join(pluginRoot, "setup-api.mjs"),
        `export { default } from ${JSON.stringify(resolveRuntimeWorkerUrl(entry).href)};`,
      );
      await fs.copyFile(path.join(pluginRoot, "setup-api.mjs"), path.join(pluginRoot, "index.mjs"));
      const backend = withEnv({ OPENCLAW_BUNDLED_PLUGINS_DIR: bundled }, () =>
        resolveCliBackendConfig(provider),
      );
      expect(backend).not.toBeNull();
      const compactAgentHarnessSession = vi.fn();
      const scenario = await prepareCompactionScenario({
        suffix: `${provider}-owns-compaction`,
        tmpDir,
        provider,
        sessionEntry: {
          cliSessionBindings: { [provider]: { sessionId: "native-session" } },
        },
        deps: {
          maybeCompactAgentHarnessSession: compactAgentHarnessSession as never,
          resolveCliBackendConfig: () => backend,
        },
      });
      const { compactCalls, recordCliCompactionInStore, sessionEntry } = scenario;
      const updatedEntry = await scenario.run();

      expect(compactAgentHarnessSession).not.toHaveBeenCalled();
      expect(compactCalls).toHaveLength(0);
      expect(recordCliCompactionInStore).not.toHaveBeenCalled();
      expect(updatedEntry).toBe(sessionEntry);
      expect(updatedEntry?.cliSessionBindings?.[provider]?.sessionId).toBe("native-session");
    },
  );

  it("does not skip compaction when backend does not declare ownsNativeCompaction", async () => {
    const scenario = await prepareCompactionScenario({
      suffix: "generic-no-ownership",
      tmpDir,
      provider: "generic-backend",
      model: "model",
      deps: {
        resolveCliBackendConfig: () => ({
          id: "generic-backend",
          config: { command: "generic" },
          bundleMcp: false,
        }),
      },
    });
    await scenario.run();

    expect(scenario.compactCalls).toHaveLength(1);
  });

  it("still uses native harness path when backend declares ownsNativeCompaction and has agentHarnessId", async () => {
    const compactAgentHarnessSession = vi.fn(async () => ({
      ok: true,
      compacted: true,
      result: { tokensBefore: 950, tokensAfter: 100 },
    }));
    const scenario = await prepareCompactionScenario({
      suffix: "codex-with-ownership",
      tmpDir,
      provider: "openai",
      model: "gpt-5.5",
      sessionEntry: { agentHarnessId: "codex" },
      deps: {
        maybeCompactAgentHarnessSession: compactAgentHarnessSession as never,
        resolveCliBackendConfig: () => ({
          id: "codex",
          config: { command: "codex" },
          bundleMcp: false,
          ownsNativeCompaction: true,
        }),
        applyAgentAutoCompactionGuard: vi.fn(async () => ({
          supported: true,
          disabled: false,
        })),
      },
    });
    const { compactCalls, recordCliCompactionInStore } = scenario;
    await scenario.run();

    expect(compactAgentHarnessSession).toHaveBeenCalledTimes(1);
    expect(compactCalls).toHaveLength(0);
    expect(recordCliCompactionInStore).toHaveBeenCalledTimes(1);
  });

  it("does not compact reset-discarded tool output in the post-turn lifecycle", async () => {
    const sessionKey = "agent:main:reset-lifecycle-proof";
    const sessionId = "session-reset-lifecycle-proof";
    const storePath = path.join(tmpDir, "sessions-reset-lifecycle.sqlite");
    const sessionEntry: SessionEntry = {
      sessionId,
      updatedAt: Date.now(),
      contextTokens: 4_096,
      totalTokens: 400,
      totalTokensFresh: true,
      totalTokensVersion: SESSION_TOTAL_TOKENS_VERSION,
    };
    const sessionStore: Record<string, SessionEntry> = { [sessionKey]: sessionEntry };
    await persistSessionEntry({ sessionKey, storePath, entry: sessionEntry });

    const bigOutput = "x".repeat(20_000);
    const compactCalls: CompactParams[] = [];
    const recordCliCompactionInStore = vi.fn(async () => sessionEntry);
    setCliCompactionTestDeps({
      openSessionManager: () =>
        SessionManager.fromEntries([
          {
            type: "session",
            version: CURRENT_SESSION_VERSION,
            id: sessionId,
            timestamp: new Date(0).toISOString(),
            cwd: tmpDir,
          },
          {
            type: "message",
            id: "kept-user",
            parentId: null,
            timestamp: new Date(0).toISOString(),
            message: { role: "user", content: "kept question", timestamp: 1 },
          },
          {
            type: "message",
            id: "kept-tool",
            parentId: "kept-user",
            timestamp: new Date(0).toISOString(),
            message: {
              role: "toolResult",
              toolCallId: "call-1",
              toolName: "bash",
              content: [{ type: "text", text: bigOutput }],
              isError: false,
              timestamp: 2,
            },
          },
          {
            type: "message",
            id: "kept-assistant",
            parentId: "kept-tool",
            timestamp: new Date(0).toISOString(),
            message: {
              role: "assistant",
              content: [{ type: "text", text: "kept answer" }],
              provider: "test-provider",
              model: "test-model",
              usage: {
                input: 1,
                output: 1,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 2,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
              },
              stopReason: "stop",
              timestamp: 3,
            },
          },
          {
            type: "reset",
            id: "reset",
            parentId: "kept-assistant",
            timestamp: new Date(0).toISOString(),
            reason: "new",
            firstKeptEntryId: "kept-user",
          },
          {
            type: "message",
            id: "new",
            parentId: "reset",
            timestamp: new Date(0).toISOString(),
            message: { role: "user", content: "new turn after reset", timestamp: 4 },
          },
        ]),
      resolveContextEngine: async () => buildContextEngine({ compactCalls }),
      createPreparedEmbeddedAgentSettingsManager: async () => ({
        getCompactionReserveTokens: () => 512,
        getCompactionKeepRecentTokens: () => 0,
        applyOverrides: () => {},
      }),
      resolveLiveToolResultMaxChars: () => 20_000,
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
      provider: "claude-cli",
      model: "opus",
    });

    expect(result).toBe(sessionEntry);
    expect(compactCalls).toEqual([]);
    expect(recordCliCompactionInStore).not.toHaveBeenCalled();
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
