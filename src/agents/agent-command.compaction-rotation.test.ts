/** Tests agent command compaction rotation and persisted transcript/session updates. */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../config/sessions.js";
import {
  listSessionEntries,
  loadTranscriptEvents,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import {
  formatSqliteSessionFileMarker,
  parseSqliteSessionFileMarker,
} from "../config/sessions/sqlite-marker.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { rotateAgentEventLifecycleGeneration } from "../infra/agent-events.js";
import type { runAgentAttempt } from "./command/attempt-execution.runtime.js";
import type { EmbeddedAgentRunResult } from "./embedded-agent.js";
import type { loadManifestModelCatalog } from "./model-catalog.js";
import { createAgentRunRestartAbortError } from "./run-termination.js";

type ProviderModelNormalizationParams = { provider: string; context: { modelId: string } };
type LoadManifestModelCatalogParams = Parameters<typeof loadManifestModelCatalog>[0];
type RunAgentAttempt = typeof runAgentAttempt;
type CliCompactionParams = {
  sessionEntry?: SessionEntry;
  sessionKey: string;
  sessionStore?: Record<string, SessionEntry>;
  storePath?: string;
};

const state = vi.hoisted(() => ({
  cfg: undefined as OpenClawConfig | undefined,
  workspaceDir: undefined as string | undefined,
  agentDir: undefined as string | undefined,
  runAgentAttemptMock: vi.fn<RunAgentAttempt>(),
  loadManifestModelCatalogMock: vi.fn((_params: LoadManifestModelCatalogParams) => []),
  normalizeProviderModelIdWithRuntimeMock: vi.fn(
    (_params: ProviderModelNormalizationParams) => undefined,
  ),
  runCliTurnCompactionLifecycleMock: vi.fn(
    async (params: CliCompactionParams) => params.sessionEntry,
  ),
  deliverAgentCommandResultMock: vi.fn(),
  emitAgentEventMock: vi.fn(),
  deliveryFreshEntries: [] as Array<SessionEntry | undefined>,
}));

vi.mock("../config/io.js", () => ({
  getRuntimeConfig: () => state.cfg,
  readConfigFileSnapshotForWrite: async () => ({ snapshot: { valid: false } }),
}));

vi.mock("./agent-runtime-config.js", () => ({
  resolveAgentRuntimeConfig: async () => ({
    loadedRaw: state.cfg,
    sourceConfig: state.cfg,
    cfg: state.cfg,
  }),
}));

vi.mock("./agent-scope.js", async () => {
  const actual = await vi.importActual<typeof import("./agent-scope.js")>("./agent-scope.js");
  return {
    ...actual,
    clearAutoFallbackPrimaryProbeSelection: vi.fn(),
    entryMatchesAutoFallbackPrimaryProbe: () => false,
    hasSessionAutoModelFallbackProvenance: () => false,
    listAgentIds: () => ["main"],
    markAutoFallbackPrimaryProbe: vi.fn(),
    resolveAutoFallbackPrimaryProbe: () => undefined,
    resolveAgentConfig: () => undefined,
    resolveAgentDir: () => state.agentDir ?? "/tmp/openclaw-agent",
    resolveDefaultAgentId: () => "main",
    resolveEffectiveModelFallbacks: () => undefined,
    resolveSessionAgentId: () => "main",
    resolveAgentWorkspaceDir: () => state.workspaceDir ?? "/tmp/openclaw-workspace",
  };
});

vi.mock("../plugins/manifest-contract-eligibility.js", () => ({
  loadManifestMetadataSnapshot: () => ({ plugins: [] }),
}));

vi.mock("./model-catalog.js", () => ({
  loadManifestModelCatalog: (params: LoadManifestModelCatalogParams) =>
    state.loadManifestModelCatalogMock(params),
}));

vi.mock("./provider-model-normalization.runtime.js", () => ({
  normalizeProviderModelIdWithRuntime: (params: {
    provider: string;
    context: { modelId: string };
  }) => state.normalizeProviderModelIdWithRuntimeMock(params),
}));

vi.mock("./harness/runtime-plugin.js", () => ({
  ensureSelectedAgentHarnessPlugin: vi.fn(async () => undefined),
}));

vi.mock("./workspace.js", () => ({
  ensureAgentWorkspace: vi.fn(async () => undefined),
}));

vi.mock("./auth-profiles/store.js", async () => {
  const actual = await vi.importActual<typeof import("./auth-profiles/store.js")>(
    "./auth-profiles/store.js",
  );
  return {
    ...actual,
    ensureAuthProfileStore: () => ({ profiles: {} }),
    saveAuthProfileStore: vi.fn(),
    updateAuthProfileStoreWithLock: vi.fn(async () => ({ profiles: {} })),
  };
});

vi.mock("../acp/control-plane/manager.js", () => ({
  getAcpSessionManager: () => ({
    resolveSession: () => null,
  }),
}));

vi.mock("../skills/runtime/remote.js", () => ({
  getRemoteSkillEligibility: () => ({ enabled: false, reason: "test" }),
}));

vi.mock("../skills/runtime/session-snapshot.js", () => ({
  resolveReusableWorkspaceSkillSnapshot: () => ({
    shouldRefresh: true,
    snapshot: {
      prompt: "",
      skills: [],
      resolvedSkills: [],
      version: 0,
    },
  }),
}));

vi.mock("./exec-defaults.js", () => ({
  resolveNodeExecEligibility: () => ({ canExec: false }),
}));

vi.mock("./model-fallback.js", () => ({
  runWithModelFallback: async (params: {
    provider: string;
    model: string;
    run: (provider: string, model: string) => Promise<unknown>;
  }) => ({
    result: await params.run(params.provider, params.model),
    provider: params.provider,
    model: params.model,
    attempts: [],
  }),
}));

vi.mock("./command/attempt-execution.runtime.js", async () => {
  const actual = await vi.importActual<typeof import("./command/attempt-execution.runtime.js")>(
    "./command/attempt-execution.runtime.js",
  );
  return {
    ...actual,
    runAgentAttempt: (...args: Parameters<RunAgentAttempt>) => state.runAgentAttemptMock(...args),
  };
});

vi.mock("./command/cli-compaction.js", () => ({
  runCliTurnCompactionLifecycle: (params: CliCompactionParams) =>
    state.runCliTurnCompactionLifecycleMock(params),
}));

vi.mock("../infra/agent-events.js", async () => {
  const actual = await vi.importActual<typeof import("../infra/agent-events.js")>(
    "../infra/agent-events.js",
  );
  return {
    ...actual,
    emitAgentEvent: (...args: Parameters<typeof actual.emitAgentEvent>) => {
      state.emitAgentEventMock(...args);
      return actual.emitAgentEvent(...args);
    },
  };
});

vi.mock("./command/delivery.runtime.js", () => ({
  deliverAgentCommandResult: (params: unknown) => state.deliverAgentCommandResultMock(params),
}));

let agentCommand: typeof import("./agent-command.js").agentCommand;

beforeAll(async () => {
  agentCommand = (await import("./agent-command.js")).agentCommand;
});

beforeEach(async () => {
  vi.clearAllMocks();
  state.loadManifestModelCatalogMock.mockReturnValue([]);
  state.normalizeProviderModelIdWithRuntimeMock.mockImplementation(() => undefined);
  state.runCliTurnCompactionLifecycleMock.mockImplementation(
    async (params: CliCompactionParams) => params.sessionEntry,
  );
  state.deliveryFreshEntries = [];
  state.deliverAgentCommandResultMock.mockImplementation(
    async (params: {
      resolveFreshSessionEntryForDelivery?: () => Promise<SessionEntry | undefined>;
    }) => {
      state.deliveryFreshEntries.push(await params.resolveFreshSessionEntryForDelivery?.());
      return { deliverySucceeded: true };
    },
  );
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-rotation-e2e-"));
  state.workspaceDir = path.join(tmpDir, "workspace");
  state.agentDir = path.join(tmpDir, "agent");
  await fs.mkdir(state.workspaceDir, { recursive: true });
  await fs.mkdir(state.agentDir, { recursive: true });
  state.cfg = {
    session: {
      store: path.join(tmpDir, "sessions.json"),
    },
    agents: {
      defaults: {
        models: {
          "openai/gpt-5.5": {},
        },
      },
    },
  } as OpenClawConfig;
});

afterEach(async () => {
  const storePath = state.cfg?.session?.store;
  state.cfg = undefined;
  state.workspaceDir = undefined;
  state.agentDir = undefined;
  if (storePath) {
    await fs.rm(path.dirname(storePath), { recursive: true, force: true });
  }
});

function makeResult(params: {
  sessionId: string;
  sessionFile?: string;
  text: string;
  compactionCount?: number;
  runner?: "cli" | "embedded";
  payloads?: EmbeddedAgentRunResult["payloads"];
}): EmbeddedAgentRunResult {
  return {
    payloads: params.payloads ?? [{ text: params.text }],
    meta: {
      durationMs: 1,
      stopReason: "end_turn",
      executionTrace: {
        runner: params.runner ?? "embedded",
        fallbackUsed: false,
        winnerProvider: "openai",
        winnerModel: "gpt-5.5",
      },
      finalAssistantVisibleText: params.text,
      agentMeta: {
        sessionId: params.sessionId,
        ...(params.sessionFile ? { sessionFile: params.sessionFile } : {}),
        provider: "openai",
        model: "gpt-5.5",
        ...(params.compactionCount ? { compactionCount: params.compactionCount } : {}),
      },
    },
  };
}

async function readSessionMessages(params: {
  agentId: string;
  sessionId: string;
  storePath: string;
}) {
  return (await loadTranscriptEvents(params))
    .filter(
      (entry): entry is { message: unknown; type: "message" } =>
        typeof entry === "object" &&
        entry !== null &&
        "message" in entry &&
        "type" in entry &&
        entry.type === "message",
    )
    .map((entry) => entry.message);
}

function requireStorePath(): string {
  const storePath = state.cfg?.session?.store;
  if (!storePath) {
    throw new Error("missing test session store path");
  }
  return storePath;
}

function findStoredSessionEntry(sessionKey: string): SessionEntry | undefined {
  return listSessionEntries({ storePath: requireStorePath() }).find(
    (candidate) => candidate.sessionKey === sessionKey,
  )?.entry;
}

function readLifecyclePhases(): Array<string | undefined> {
  return state.emitAgentEventMock.mock.calls
    .map(([event]) => event as { stream?: string; data?: { phase?: string } })
    .filter((event) => event.stream === "lifecycle")
    .map((event) => event.data?.phase);
}

const COMPACTION_ERROR =
  "CLI transcript compaction failed for openai/gpt-5.5: Summarization failed: Connection error.";

describe("agentCommand compaction transcript rotation", () => {
  it("does not re-normalize an exact configured custom provider through plugin runtime", async () => {
    state.normalizeProviderModelIdWithRuntimeMock.mockImplementation(
      ({ provider }: ProviderModelNormalizationParams) => {
        if (provider === "tui-pty-mock") {
          throw new Error("custom provider should not use plugin runtime normalization");
        }
        return undefined;
      },
    );
    state.cfg = {
      ...state.cfg,
      plugins: {
        enabled: false,
      },
      agents: {
        defaults: {
          model: { primary: "tui-pty-mock/gpt-5.5" },
          models: {
            "tui-pty-mock/gpt-5.5": {},
          },
        },
      },
      models: {
        mode: "replace",
        providers: {
          "tui-pty-mock": {
            baseUrl: "http://127.0.0.1:9/v1",
            apiKey: "test",
            request: { allowPrivateNetwork: true },
            models: [
              {
                id: "gpt-5.5",
                name: "GPT 5.5",
                api: "openai-responses",
                reasoning: true,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 128_000,
                maxTokens: 16_384,
              },
            ],
          },
        },
      },
    } as OpenClawConfig;
    state.runAgentAttemptMock.mockResolvedValueOnce(
      makeResult({
        sessionId: "custom-provider-session",
        text: "custom answer",
      }),
    );

    await agentCommand({
      message: "custom provider prompt",
      sessionId: "custom-provider-session",
      cwd: state.workspaceDir,
    });

    const attempt = state.runAgentAttemptMock.mock.calls[0]?.[0] as
      | { providerOverride?: string; modelOverride?: string; pluginsEnabled?: boolean }
      | undefined;
    expect(attempt).toMatchObject({
      providerOverride: "tui-pty-mock",
      modelOverride: "gpt-5.5",
      pluginsEnabled: false,
    });
    expect(state.normalizeProviderModelIdWithRuntimeMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ provider: "tui-pty-mock" }),
    );
    expect(state.loadManifestModelCatalogMock).not.toHaveBeenCalled();
  });

  it("keeps SQLite session state on the rotated successor", async () => {
    const storePath = requireStorePath();
    const rotatedSessionFile = formatSqliteSessionFileMarker({
      agentId: "main",
      sessionId: "rotated-session",
      storePath,
    });
    state.runAgentAttemptMock.mockResolvedValueOnce(
      makeResult({
        sessionId: "rotated-session",
        sessionFile: rotatedSessionFile,
        text: "first answer after rotation",
        compactionCount: 1,
      }),
    );

    await agentCommand({
      message: "first prompt",
      sessionId: "old-session",
      cwd: state.workspaceDir,
    });

    const storeAfterRotation = Object.fromEntries(
      listSessionEntries({ storePath }).map(({ entry, sessionKey }) => [sessionKey, entry]),
    );
    const entriesAfterRotation = Object.entries(storeAfterRotation);
    expect(entriesAfterRotation).toHaveLength(1);
    const [sessionKey, rotatedEntry] = entriesAfterRotation[0] ?? [];
    expect(sessionKey).toBe("agent:main:explicit:old-session");
    expect(rotatedEntry).toMatchObject({
      sessionId: "rotated-session",
      sessionFile: rotatedSessionFile,
      usageFamilyKey: "agent:main:explicit:old-session",
      usageFamilySessionIds: ["old-session", "rotated-session"],
      compactionCount: 1,
    });
    await expect(
      readSessionMessages({ agentId: "main", sessionId: "rotated-session", storePath }),
    ).resolves.toContainEqual(expect.objectContaining({ role: "assistant" }));
  });

  it.each(["cli", "embedded"] as const)(
    "persists the pending final before %s compaction failure and still delivers",
    async (runner) => {
      const sessionId = `${runner}-compaction-failure`;
      const sessionKey = `agent:main:explicit:${sessionId}`;
      const text = `${runner} reply generated before compaction`;
      let compactionSessionEntry: SessionEntry | undefined;
      let storedEntryBeforeCompaction: SessionEntry | undefined;
      state.runAgentAttemptMock.mockResolvedValueOnce(makeResult({ sessionId, text, runner }));
      state.runCliTurnCompactionLifecycleMock.mockImplementationOnce(async (params) => {
        compactionSessionEntry = params.sessionEntry;
        storedEntryBeforeCompaction = findStoredSessionEntry(sessionKey);
        throw new Error(COMPACTION_ERROR);
      });

      const result = await agentCommand({
        message: "room message",
        sessionId,
        sessionKey,
        cwd: state.workspaceDir,
        channel: "discord",
        to: "discord:dm:123",
        accountId: "main",
        deliver: true,
      });

      expect(compactionSessionEntry).toMatchObject({
        pendingFinalDelivery: true,
        pendingFinalDeliveryText: text,
        pendingFinalDeliveryContext: {
          channel: "discord",
          to: "discord:dm:123",
          accountId: "main",
        },
      });
      expect(storedEntryBeforeCompaction).toMatchObject({
        pendingFinalDelivery: true,
        pendingFinalDeliveryText: text,
      });
      expect(result).toMatchObject({ deliverySucceeded: true });
      expect(state.deliverAgentCommandResultMock).toHaveBeenCalledOnce();
      expect(state.deliverAgentCommandResultMock).toHaveBeenCalledWith(
        expect.objectContaining({ payloads: [{ text }] }),
      );
      expect(readLifecyclePhases()).toContain("end");
      expect(readLifecyclePhases()).not.toContain("error");
      const storedEntryAfterDelivery = findStoredSessionEntry(sessionKey);
      expect(storedEntryAfterDelivery?.pendingFinalDelivery).toBeUndefined();
      expect(storedEntryAfterDelivery?.pendingFinalDeliveryText).toBeUndefined();
    },
  );

  it("excludes hidden reasoning from the pending final persisted before compaction", async () => {
    const sessionId = "reasoning-filter-compaction-failure";
    const sessionKey = `agent:main:explicit:${sessionId}`;
    const hiddenReasoning = "private chain of thought";
    const visibleFinal = "visible final answer";
    let pendingTextSeenByCompaction: string | undefined;
    state.runAgentAttemptMock.mockResolvedValueOnce(
      makeResult({
        sessionId,
        text: visibleFinal,
        payloads: [{ text: hiddenReasoning, isReasoning: true }, { text: visibleFinal }],
      }),
    );
    state.runCliTurnCompactionLifecycleMock.mockImplementationOnce(async (params) => {
      pendingTextSeenByCompaction = params.sessionEntry?.pendingFinalDeliveryText ?? undefined;
      throw new Error(COMPACTION_ERROR);
    });

    const result = await agentCommand({
      message: "room message",
      sessionId,
      sessionKey,
      cwd: state.workspaceDir,
      channel: "discord",
      to: "discord:dm:123",
      accountId: "main",
      deliver: true,
    });

    expect(pendingTextSeenByCompaction).toBe(visibleFinal);
    expect(pendingTextSeenByCompaction).not.toContain(hiddenReasoning);
    expect(result).toMatchObject({ deliverySucceeded: true });
    expect(state.deliverAgentCommandResultMock).toHaveBeenCalledOnce();
    const storedEntry = findStoredSessionEntry(sessionKey);
    expect(storedEntry?.pendingFinalDelivery).toBeUndefined();
    expect(storedEntry?.pendingFinalDeliveryText).toBeUndefined();
  });

  it("preserves media directives in the pending final persisted before compaction", async () => {
    const sessionId = "media-directive-compaction-failure";
    const sessionKey = `agent:main:explicit:${sessionId}`;
    const text = "Rendered chart\nMEDIA:/tmp/chart.png";
    let pendingTextSeenByCompaction: string | undefined;
    state.runAgentAttemptMock.mockResolvedValueOnce(makeResult({ sessionId, text }));
    state.runCliTurnCompactionLifecycleMock.mockImplementationOnce(async (params) => {
      pendingTextSeenByCompaction = params.sessionEntry?.pendingFinalDeliveryText ?? undefined;
      throw new Error(COMPACTION_ERROR);
    });

    const result = await agentCommand({
      message: "room message",
      sessionId,
      sessionKey,
      cwd: state.workspaceDir,
      channel: "discord",
      to: "discord:dm:123",
      accountId: "main",
      deliver: true,
    });

    expect(pendingTextSeenByCompaction).toBe(text);
    expect(result).toMatchObject({ deliverySucceeded: true });
    expect(state.deliverAgentCommandResultMock).toHaveBeenCalledWith(
      expect.objectContaining({ payloads: [{ text }] }),
    );
    const storedEntry = findStoredSessionEntry(sessionKey);
    expect(storedEntry?.pendingFinalDelivery).toBeUndefined();
    expect(storedEntry?.pendingFinalDeliveryText).toBeUndefined();
  });

  it("adopts a successful compaction successor for delivery and marker cleanup", async () => {
    const sessionId = "pre-compaction-session";
    const successorSessionId = "post-compaction-session";
    const sessionKey = `agent:main:explicit:${sessionId}`;
    const text = "reply carried across successful compaction";
    const successorSessionFile = formatSqliteSessionFileMarker({
      agentId: "main",
      sessionId: successorSessionId,
      storePath: requireStorePath(),
    });
    let successorBeforeCleanup: SessionEntry | undefined;
    let compactionSetupError: Error | undefined;
    state.runAgentAttemptMock.mockResolvedValueOnce(makeResult({ sessionId, text }));
    state.runCliTurnCompactionLifecycleMock.mockImplementationOnce(async (params) => {
      if (!params.sessionEntry || !params.sessionStore || !params.storePath) {
        compactionSetupError = new Error("compaction test requires persisted session state");
        throw compactionSetupError;
      }
      successorBeforeCleanup = {
        ...params.sessionEntry,
        sessionId: successorSessionId,
        sessionFile: successorSessionFile,
        updatedAt: Date.now(),
      };
      await replaceSessionEntry(
        { sessionKey: params.sessionKey, storePath: params.storePath },
        successorBeforeCleanup,
      );
      params.sessionStore[params.sessionKey] = successorBeforeCleanup;
      return successorBeforeCleanup;
    });

    const result = await agentCommand({
      message: "room message",
      sessionId,
      sessionKey,
      cwd: state.workspaceDir,
      channel: "discord",
      to: "discord:dm:123",
      accountId: "main",
      deliver: true,
    });

    expect(compactionSetupError).toBeUndefined();
    expect(successorBeforeCleanup).toMatchObject({
      sessionId: successorSessionId,
      pendingFinalDelivery: true,
      pendingFinalDeliveryText: text,
    });
    expect(result).toMatchObject({ deliverySucceeded: true });
    expect(state.deliveryFreshEntries.at(-1)).toMatchObject({
      sessionId: successorSessionId,
      sessionFile: successorSessionFile,
      pendingFinalDelivery: true,
      pendingFinalDeliveryText: text,
    });
    const storedSuccessor = findStoredSessionEntry(sessionKey);
    expect(storedSuccessor).toMatchObject({
      sessionId: successorSessionId,
      sessionFile: successorSessionFile,
    });
    expect(storedSuccessor?.pendingFinalDelivery).toBeUndefined();
    expect(storedSuccessor?.pendingFinalDeliveryText).toBeUndefined();
    expect(storedSuccessor?.restartRecoveryDeliveryContext).toBeUndefined();
    expect(storedSuccessor?.restartRecoveryDeliveryRunId).toBeUndefined();
  });

  it("retains the pending final when delivery fails after compaction failure", async () => {
    const sessionId = "delivery-failure-after-compaction";
    const sessionKey = `agent:main:explicit:${sessionId}`;
    const text = "reply awaiting restart recovery";
    state.runAgentAttemptMock.mockResolvedValueOnce(makeResult({ sessionId, text }));
    state.runCliTurnCompactionLifecycleMock.mockRejectedValueOnce(new Error(COMPACTION_ERROR));
    state.deliverAgentCommandResultMock.mockResolvedValueOnce({ deliverySucceeded: false });

    const result = await agentCommand({
      message: "room message",
      sessionId,
      sessionKey,
      cwd: state.workspaceDir,
      channel: "discord",
      to: "discord:dm:123",
      accountId: "main",
      deliver: true,
    });

    expect(result).toMatchObject({ deliverySucceeded: false });
    expect(state.deliverAgentCommandResultMock).toHaveBeenCalledOnce();
    expect(findStoredSessionEntry(sessionKey)).toMatchObject({
      pendingFinalDelivery: true,
      pendingFinalDeliveryText: text,
      pendingFinalDeliveryContext: {
        channel: "discord",
        to: "discord:dm:123",
        accountId: "main",
      },
    });
  });

  it("does not deliver or clear the pending final when restart aborts compaction", async () => {
    const sessionId = "restart-during-compaction";
    const sessionKey = `agent:main:explicit:${sessionId}`;
    const text = "reply owned by restart recovery";
    const abortController = new AbortController();
    state.runAgentAttemptMock.mockResolvedValueOnce(makeResult({ sessionId, text }));
    state.runCliTurnCompactionLifecycleMock.mockImplementationOnce(async (params) => {
      expect(params.sessionEntry).toMatchObject({
        pendingFinalDelivery: true,
        pendingFinalDeliveryText: text,
      });
      abortController.abort(createAgentRunRestartAbortError());
      throw new Error(COMPACTION_ERROR);
    });

    await expect(
      agentCommand({
        message: "room message",
        sessionId,
        sessionKey,
        cwd: state.workspaceDir,
        channel: "discord",
        to: "discord:dm:123",
        accountId: "main",
        deliver: true,
        abortSignal: abortController.signal,
      }),
    ).rejects.toThrow("agent run aborted for restart");

    expect(state.deliverAgentCommandResultMock).not.toHaveBeenCalled();
    expect(findStoredSessionEntry(sessionKey)).toMatchObject({
      pendingFinalDelivery: true,
      pendingFinalDeliveryText: text,
    });
  });

  it("does not deliver or clear the pending final when restart wins after successful compaction", async () => {
    const sessionId = "restart-after-successful-compaction";
    const sessionKey = `agent:main:explicit:${sessionId}`;
    const text = "reply owned by restart recovery after compaction";
    const abortController = new AbortController();
    state.runAgentAttemptMock.mockResolvedValueOnce(makeResult({ sessionId, text }));
    state.runCliTurnCompactionLifecycleMock.mockImplementationOnce(async (params) => {
      expect(params.sessionEntry).toMatchObject({
        pendingFinalDelivery: true,
        pendingFinalDeliveryText: text,
      });
      abortController.abort(createAgentRunRestartAbortError());
      return params.sessionEntry;
    });

    await expect(
      agentCommand({
        message: "room message",
        sessionId,
        sessionKey,
        cwd: state.workspaceDir,
        channel: "discord",
        to: "discord:dm:123",
        accountId: "main",
        deliver: true,
        abortSignal: abortController.signal,
      }),
    ).rejects.toThrow("agent run aborted for restart");

    expect(state.deliverAgentCommandResultMock).not.toHaveBeenCalled();
    expect(findStoredSessionEntry(sessionKey)).toMatchObject({
      pendingFinalDelivery: true,
      pendingFinalDeliveryText: text,
    });
  });

  it("does not deliver or clear the pending final after lifecycle ownership turns stale", async () => {
    const sessionId = "stale-during-compaction";
    const sessionKey = `agent:main:explicit:${sessionId}`;
    const text = "reply owned by the next gateway lifecycle";
    state.runAgentAttemptMock.mockResolvedValueOnce(makeResult({ sessionId, text }));
    state.runCliTurnCompactionLifecycleMock.mockImplementationOnce(async (params) => {
      expect(params.sessionEntry).toMatchObject({
        pendingFinalDelivery: true,
        pendingFinalDeliveryText: text,
      });
      rotateAgentEventLifecycleGeneration();
      throw new Error(COMPACTION_ERROR);
    });

    await expect(
      agentCommand({
        message: "room message",
        sessionId,
        sessionKey,
        cwd: state.workspaceDir,
        channel: "discord",
        to: "discord:dm:123",
        accountId: "main",
        deliver: true,
      }),
    ).rejects.toThrow("Agent run belongs to a stale gateway lifecycle");

    expect(state.deliverAgentCommandResultMock).not.toHaveBeenCalled();
    expect(findStoredSessionEntry(sessionKey)).toMatchObject({
      pendingFinalDelivery: true,
      pendingFinalDeliveryText: text,
    });
  });

  it.each([
    ["empty payloads", "empty", []],
    ["a silent NO_REPLY payload", "silent", [{ text: "NO_REPLY" }]],
    ["a reasoning-only payload", "reasoning", [{ text: "hidden reasoning", isReasoning: true }]],
    ["a heartbeat-only payload", "heartbeat", [{ text: "HEARTBEAT_OK" }]],
    ["an outbound-suppressed relay placeholder", "relay-status", [{ text: "No channel reply." }]],
  ] as const)(
    "keeps compaction failure fatal for %s without manufacturing delivery state",
    async (_label, sessionSuffix, payloads) => {
      const sessionId = `no-reply-compaction-failure-${sessionSuffix}`;
      const sessionKey = `agent:main:explicit:${sessionId}`;
      state.runAgentAttemptMock.mockResolvedValueOnce({
        payloads: [...payloads],
        meta: {
          durationMs: 1,
          stopReason: "end_turn",
          executionTrace: {
            runner: "cli",
            fallbackUsed: false,
            winnerProvider: "openai",
            winnerModel: "gpt-5.5",
          },
          agentMeta: {
            sessionId,
            provider: "openai",
            model: "gpt-5.5",
          },
        },
      });
      state.runCliTurnCompactionLifecycleMock.mockRejectedValueOnce(new Error(COMPACTION_ERROR));

      await expect(
        agentCommand({
          message: "prompt with no assistant reply",
          sessionId,
          sessionKey,
          cwd: state.workspaceDir,
          channel: "discord",
          to: "discord:dm:123",
          accountId: "main",
          deliver: true,
        }),
      ).rejects.toThrow("Summarization failed: Connection error");

      expect(state.runCliTurnCompactionLifecycleMock).toHaveBeenCalledOnce();
      expect(state.deliverAgentCommandResultMock).not.toHaveBeenCalled();
      const storedEntry = findStoredSessionEntry(sessionKey);
      expect(storedEntry?.pendingFinalDelivery).toBeUndefined();
      expect(storedEntry?.pendingFinalDeliveryText).toBeUndefined();
      expect(readLifecyclePhases()).toContain("error");
    },
  );

  it("skips post-turn compaction before delivering sendable finals that pending text cannot replay", async () => {
    const sessionId = "unrecoverable-media-before-compaction";
    const sessionKey = `agent:main:explicit:${sessionId}`;
    const payloads = [{ mediaUrl: "/tmp/reply.ogg", audioAsVoice: true }];
    state.runAgentAttemptMock.mockResolvedValueOnce(makeResult({ sessionId, text: "", payloads }));

    const result = await agentCommand({
      message: "room message",
      sessionId,
      sessionKey,
      cwd: state.workspaceDir,
      channel: "discord",
      to: "discord:dm:123",
      accountId: "main",
      deliver: true,
    });

    expect(state.runCliTurnCompactionLifecycleMock).not.toHaveBeenCalled();
    expect(state.deliverAgentCommandResultMock).toHaveBeenCalledOnce();
    expect(state.deliverAgentCommandResultMock).toHaveBeenCalledWith(
      expect.objectContaining({ payloads }),
    );
    expect(result).toMatchObject({ deliverySucceeded: true });
    const storedEntry = findStoredSessionEntry(sessionKey);
    expect(storedEntry?.pendingFinalDelivery).toBeUndefined();
    expect(storedEntry?.pendingFinalDeliveryText).toBeUndefined();
  });

  it("skips post-turn compaction when a recoverable final cannot persist a pending marker", async () => {
    const sessionId = "subagent-no-pending-marker";
    const sessionKey = `agent:main:subagent:${sessionId}`;
    const text = "subagent final must deliver before compaction";
    state.runAgentAttemptMock.mockResolvedValueOnce(makeResult({ sessionId, text }));

    const result = await agentCommand({
      message: "subagent room message",
      sessionId,
      sessionKey,
      cwd: state.workspaceDir,
      channel: "discord",
      to: "discord:dm:123",
      accountId: "main",
      deliver: true,
    });

    expect(state.runCliTurnCompactionLifecycleMock).not.toHaveBeenCalled();
    expect(state.deliverAgentCommandResultMock).toHaveBeenCalledOnce();
    expect(state.deliverAgentCommandResultMock).toHaveBeenCalledWith(
      expect.objectContaining({ payloads: [{ text }] }),
    );
    expect(result).toMatchObject({ deliverySucceeded: true });
    const storedEntry = findStoredSessionEntry(sessionKey);
    expect(storedEntry?.pendingFinalDelivery).toBeUndefined();
    expect(storedEntry?.pendingFinalDeliveryText).toBeUndefined();
  });

  it("keeps post-turn compaction for no-delivery runs with unrecoverable sendable finals", async () => {
    const sessionId = "unrecoverable-media-no-delivery";
    const sessionKey = `agent:main:explicit:${sessionId}`;
    const payloads = [{ mediaUrl: "/tmp/reply.ogg", audioAsVoice: true }];
    state.runAgentAttemptMock.mockResolvedValueOnce(makeResult({ sessionId, text: "", payloads }));

    await agentCommand({
      message: "local model run",
      sessionId,
      sessionKey,
      cwd: state.workspaceDir,
      channel: "discord",
      to: "discord:dm:123",
      accountId: "main",
      deliver: false,
    });

    expect(state.runCliTurnCompactionLifecycleMock).toHaveBeenCalledOnce();
    expect(state.deliverAgentCommandResultMock).toHaveBeenCalledOnce();
  });

  it("keeps post-turn compaction failures fatal for no-delivery runs", async () => {
    const sessionId = "no-delivery-compaction-failure";
    const sessionKey = `agent:main:explicit:${sessionId}`;
    state.runAgentAttemptMock.mockResolvedValueOnce(makeResult({ sessionId, text: "local final" }));
    state.runCliTurnCompactionLifecycleMock.mockRejectedValueOnce(new Error(COMPACTION_ERROR));

    await expect(
      agentCommand({
        message: "local model run",
        sessionId,
        sessionKey,
        cwd: state.workspaceDir,
        channel: "discord",
        to: "discord:dm:123",
        accountId: "main",
        deliver: false,
      }),
    ).rejects.toThrow("Summarization failed: Connection error");

    expect(state.runCliTurnCompactionLifecycleMock).toHaveBeenCalledOnce();
  });

  it("resumes the next turn from the rotated successor", async () => {
    const storePath = requireStorePath();
    const rotatedSessionFile = formatSqliteSessionFileMarker({
      agentId: "main",
      sessionId: "rotated-session",
      storePath,
    });
    const sessionKey = "agent:main:explicit:old-session";
    await replaceSessionEntry(
      { sessionKey, storePath },
      {
        sessionId: "rotated-session",
        sessionFile: rotatedSessionFile,
        updatedAt: Date.now(),
        usageFamilyKey: sessionKey,
        usageFamilySessionIds: ["old-session", "rotated-session"],
        compactionCount: 1,
      },
    );
    state.runAgentAttemptMock.mockResolvedValueOnce(
      makeResult({
        sessionId: "rotated-session",
        text: "second answer",
      }),
    );

    await agentCommand({
      message: "second prompt",
      sessionId: "rotated-session",
      cwd: state.workspaceDir,
    });

    const secondAttempt = state.runAgentAttemptMock.mock.calls[0]?.[0] as
      | { sessionId?: string; sessionFile?: string; sessionKey?: string }
      | undefined;
    expect(secondAttempt).toMatchObject({
      sessionId: "rotated-session",
      sessionKey,
    });
    expect(parseSqliteSessionFileMarker(secondAttempt?.sessionFile)).toMatchObject({
      agentId: "main",
      sessionId: "rotated-session",
      storePath,
    });
    expect(state.deliveryFreshEntries.at(-1)).toMatchObject({
      sessionId: "rotated-session",
      sessionFile: rotatedSessionFile,
    });
    const persisted = Object.fromEntries(
      listSessionEntries({ storePath }).map(({ entry, sessionKey: key }) => [key, entry]),
    );
    expect(persisted[sessionKey]).toMatchObject({
      sessionId: "rotated-session",
      sessionFile: rotatedSessionFile,
    });
  });
});
