/** Tests agent command compaction rotation and persisted transcript/session updates. */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { InternalSessionEntry, SessionEntry } from "../config/sessions.js";
import { formatSqliteSessionFileMarker } from "../config/sessions/legacy-sqlite-marker.js";
import { SessionWorkStartInvalidatedError } from "../config/sessions/lifecycle.js";
import {
  appendTranscriptEvent,
  appendTranscriptMessage,
  listSessionEntriesCore,
  loadTranscriptEvents,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import { createSessionDiffBaselineCaptureClaim } from "../config/sessions/session-diff-baseline-capture.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { rotateAgentEventLifecycleGeneration } from "../infra/agent-events.js";
import { defaultRuntime } from "../runtime.js";
import type { runAgentAttempt } from "./command/attempt-execution.runtime.js";
import type { EmbeddedAgentRunResult } from "./embedded-agent.js";
import type { loadManifestModelCatalog } from "./model-catalog.js";
import { createAgentRunRestartAbortError } from "./run-termination.js";

type ProviderModelNormalizationParams = { provider: string; context: { modelId: string } };
type LoadManifestModelCatalogParams = Parameters<typeof loadManifestModelCatalog>[0];
type RunAgentAttempt = typeof runAgentAttempt;
type CaptureSessionDiffBaseline =
  (typeof import("../sessions/session-diff.js"))["captureSessionDiffBaseline"];
type CliCompactionParams = {
  pluginGeneration?: unknown;
  sessionId: string;
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
  runMemoryFlushIfNeededMock: vi.fn(async (params: { sessionEntry?: SessionEntry }) => ({
    sessionEntry: params.sessionEntry,
    outcome: "completed" as const,
  })),
  deliverAgentCommandResultMock: vi.fn(),
  emitAgentEventMock: vi.fn(),
  deliveryFreshEntries: [] as Array<SessionEntry | undefined>,
  captureSessionDiffBaselineMock: vi.fn<CaptureSessionDiffBaseline>(),
}));

vi.mock("../sessions/session-diff.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../sessions/session-diff.js")>()),
  captureSessionDiffBaseline: (params: Parameters<CaptureSessionDiffBaseline>[0]) =>
    state.captureSessionDiffBaselineMock(params),
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

vi.mock("../plugins/plugin-metadata-snapshot.js", () => ({
  isPluginMetadataSnapshotCompatible: () => false,
  resolvePluginMetadataSnapshot: () => ({ plugins: [] }),
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

vi.mock("./model-catalog.js", () => ({
  loadManifestModelCatalog: (params: LoadManifestModelCatalogParams) =>
    state.loadManifestModelCatalogMock(params),
}));

vi.mock("./model-catalog.runtime.js", () => ({
  loadProviderScopedThinkingCatalog: vi.fn(async () => []),
  loadPreparedModelCatalogSnapshot: vi.fn(async () => ({
    entries: [],
    routeVariants: [],
  })),
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

vi.mock("./runtime-plugins.js", () => ({
  withAgentPluginRegistry: ({ run }: { run: () => unknown }) => run(),
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

vi.mock("./model-fallback-runner.js", () => ({
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

vi.mock("../auto-reply/reply/agent-runner-memory.js", () => ({
  runMemoryFlushIfNeeded: (params: { sessionEntry?: SessionEntry }) =>
    state.runMemoryFlushIfNeededMock(params),
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
let agentCommandFromGatewayIngress: typeof import("./agent-command.js").agentCommandFromGatewayIngress;

beforeAll(async () => {
  ({ agentCommand, agentCommandFromGatewayIngress } = await import("./agent-command.js"));
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
        runner: params.runner ?? "cli",
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
  return listSessionEntriesCore({ storePath: requireStorePath() }).find(
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
const GATEWAY_INGRESS_ARGS = [defaultRuntime, undefined, {}] as const;

describe("agentCommand compaction transcript rotation", () => {
  it.each([
    ["settles a precreated baseline claim before embedded execution", false],
    ["does not execute after baseline work-start invalidation", true],
  ] as const)("%s", async (_name, invalidated) => {
    const sessionId = invalidated ? "invalidated-agent-command" : "precreated-agent-command",
      sessionKey = `agent:main:explicit:${sessionId}`;
    await replaceSessionEntry({ sessionKey, storePath: requireStorePath() }, {
      sessionId,
      sessionDiffBaselineCapture: createSessionDiffBaselineCaptureClaim(),
      updatedAt: Date.now(),
    } as InternalSessionEntry);
    if (invalidated) {
      const error = new SessionWorkStartInvalidatedError(
        "session changed during baseline settlement",
      );
      state.captureSessionDiffBaselineMock.mockRejectedValueOnce(error);
      await expect(
        agentCommand({ message: "must not execute", sessionId, sessionKey }),
      ).rejects.toBe(error);
      expect(state.runAgentAttemptMock).not.toHaveBeenCalled();
      return;
    }
    state.captureSessionDiffBaselineMock.mockResolvedValueOnce({
      version: 1,
      sessionId,
      root: "/workspace",
      files: [],
    });
    state.runAgentAttemptMock.mockImplementationOnce(async () => {
      expect(findStoredSessionEntry(sessionKey)?.sessionDiffBaseline).toMatchObject({
        version: 1,
        sessionId,
      });
      return makeResult({ sessionId, text: "captured before execution" });
    });

    await agentCommand({ message: "write after capture", sessionId, sessionKey });
    expect(state.captureSessionDiffBaselineMock).toHaveBeenCalledOnce();
  });

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
      userTurnTranscriptRecorder: { message: { __openclaw: { senderIsOwner: true } } },
    });
    expect(state.normalizeProviderModelIdWithRuntimeMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ provider: "tui-pty-mock" }),
    );
    expect(state.loadManifestModelCatalogMock).not.toHaveBeenCalled();
  });

  it.each([
    [true, "external_user", true],
    [true, "inter_session", false],
    [true, "internal_system", false],
    [false, "external_user", false],
  ] as const)(
    "preserves human transcript ownership for %s/%s",
    async (senderIsOwner, kind, owner) => {
      const inputProvenance = { kind, sourceTool: "test" };
      state.runAgentAttemptMock.mockResolvedValueOnce(
        makeResult({ sessionId: "owned", text: "ok" }),
      );
      await agentCommand({
        message: "remember",
        sessionId: "owned",
        senderIsOwner,
        inputProvenance,
      });
      expect(state.runAgentAttemptMock.mock.calls[0]?.[0]).toMatchObject({
        opts: { senderIsOwner, inputProvenance },
        userTurnTranscriptRecorder: {
          message: { provenance: inputProvenance, __openclaw: { senderIsOwner: owner } },
        },
      });
    },
  );

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
      listSessionEntriesCore({ storePath }).map(({ entry, sessionKey }) => [sessionKey, entry]),
    );
    const entriesAfterRotation = Object.entries(storeAfterRotation);
    expect(entriesAfterRotation).toHaveLength(1);
    const [sessionKey, rotatedEntry] = entriesAfterRotation[0] ?? [];
    expect(sessionKey).toBe("agent:main:explicit:old-session");
    expect(rotatedEntry).toMatchObject({
      sessionId: "rotated-session",
      usageFamilyKey: "agent:main:explicit:old-session",
      usageFamilySessionIds: ["old-session", "rotated-session"],
      compactionCount: 1,
    });
    await expect(
      readSessionMessages({ agentId: "main", sessionId: "rotated-session", storePath }),
    ).resolves.toContainEqual(expect.objectContaining({ role: "assistant" }));
  });

  it("keeps embedded transcript ownership and flushes once for gateway ingress", async () => {
    const storePath = requireStorePath();
    const sessionId = "embedded-projected-final";
    const sessionKey = `agent:main:explicit:${sessionId}`;
    await replaceSessionEntry(
      { sessionKey, storePath },
      {
        sessionId,
        updatedAt: Date.now(),
        totalTokens: 180_000,
        totalTokensFresh: true,
        totalTokensVersion: 1,
      },
    );
    state.runAgentAttemptMock.mockImplementationOnce(async (attempt) => {
      if (!attempt.userTurnTranscriptRecorder) {
        throw new Error("missing embedded user-turn transcript recorder");
      }
      await attempt.userTurnTranscriptRecorder.persistApproved();
      await appendTranscriptMessage(
        { agentId: "main", sessionId, sessionKey, storePath },
        {
          message: {
            role: "assistant",
            content: [{ type: "text", text: "[Thu 2026-08-13 16:39 PDT] OVERRIDE-OK" }],
            api: "ollama",
            provider: "ollama",
            model: "llama3.2:latest",
            timestamp: Date.now(),
          },
          cwd: state.workspaceDir,
        },
      );
      await appendTranscriptEvent(
        { agentId: "main", sessionId, sessionKey, storePath },
        {
          type: "custom",
          customType: "openclaw:bootstrap-context:full",
          data: { runId: "embedded-run" },
        },
      );
      return makeResult({
        sessionId,
        text: "OVERRIDE-OK",
        runner: "embedded",
      });
    });

    await agentCommandFromGatewayIngress(
      {
        message: "Reply with exactly: OVERRIDE-OK",
        sessionId,
        sessionKey,
        cwd: state.workspaceDir,
        allowModelOverride: false,
      },
      ...GATEWAY_INGRESS_ARGS,
    );

    const events = (await loadTranscriptEvents({
      agentId: "main",
      sessionId,
      storePath,
    })) as Array<{
      type?: unknown;
      customType?: unknown;
      message?: { role?: unknown; api?: unknown };
    }>;
    const assistantEvents = events.filter(
      (event) => event.type === "message" && event.message?.role === "assistant",
    );
    expect(assistantEvents).toHaveLength(1);
    expect(assistantEvents.filter((event) => event.message?.api === "cli")).toHaveLength(0);
    expect(
      events.filter(
        (event) =>
          event.type === "custom" && event.customType === "openclaw:bootstrap-context:full",
      ),
    ).toHaveLength(1);
    expect(state.runMemoryFlushIfNeededMock).toHaveBeenCalledOnce();
    expect(state.runMemoryFlushIfNeededMock).toHaveBeenCalledWith(
      expect.objectContaining({ sessionEntry: expect.objectContaining({ totalTokens: 180_000 }) }),
    );
  });

  it("carries Gateway plugin generation through failed post-turn compaction and still delivers", async () => {
    const sessionId = "cli-compaction-failure";
    const sessionKey = `agent:main:explicit:${sessionId}`;
    const text = "cli reply generated before compaction";
    const pluginGeneration = {
      pluginMetadataSnapshot: { workspaceDir: state.workspaceDir },
    } as never;
    let storedEntryBeforeCompaction: SessionEntry | undefined;
    state.runAgentAttemptMock.mockResolvedValueOnce(makeResult({ sessionId, text, runner: "cli" }));
    state.runCliTurnCompactionLifecycleMock.mockImplementationOnce(async (params) => {
      expect(params.pluginGeneration).toBe(pluginGeneration);
      storedEntryBeforeCompaction = findStoredSessionEntry(sessionKey);
      throw new Error(COMPACTION_ERROR);
    });

    const result = await agentCommandFromGatewayIngress(
      {
        message: "room message",
        sessionId,
        sessionKey,
        cwd: state.workspaceDir,
        channel: "discord",
        to: "discord:dm:123",
        accountId: "main",
        deliver: true,
        allowModelOverride: false,
      },
      ...GATEWAY_INGRESS_ARGS,
      { config: state.cfg ?? {}, pluginGeneration },
    );

    expect(storedEntryBeforeCompaction).toMatchObject({
      pendingFinalDelivery: { kind: "replayable", text },
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
  });

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
      pendingTextSeenByCompaction =
        params.sessionEntry?.pendingFinalDelivery?.kind === "replayable"
          ? params.sessionEntry.pendingFinalDelivery.text
          : undefined;
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
  });

  it("preserves media directives in the pending final persisted before compaction", async () => {
    const sessionId = "media-directive-compaction-failure";
    const sessionKey = `agent:main:explicit:${sessionId}`;
    const text = "Rendered chart\nMEDIA:/tmp/chart.png";
    let pendingTextSeenByCompaction: string | undefined;
    state.runAgentAttemptMock.mockResolvedValueOnce(makeResult({ sessionId, text }));
    state.runCliTurnCompactionLifecycleMock.mockImplementationOnce(async (params) => {
      pendingTextSeenByCompaction =
        params.sessionEntry?.pendingFinalDelivery?.kind === "replayable"
          ? params.sessionEntry.pendingFinalDelivery.text
          : undefined;
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
  });

  it("adopts a successful compaction successor for delivery and marker cleanup", async () => {
    const sessionId = "pre-compaction-session";
    const successorSessionId = "post-compaction-session";
    const sessionKey = `agent:main:explicit:${sessionId}`;
    const text = "reply carried across successful compaction";
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
      pendingFinalDelivery: { kind: "replayable", text },
    });
    expect(result).toMatchObject({ deliverySucceeded: true });
    expect(state.deliveryFreshEntries.at(-1)).toMatchObject({
      sessionId: successorSessionId,
      pendingFinalDelivery: { kind: "replayable", text },
    });
    const storedSuccessor = findStoredSessionEntry(sessionKey);
    expect(storedSuccessor).toMatchObject({
      sessionId: successorSessionId,
    });
    expect(storedSuccessor?.pendingFinalDelivery).toBeUndefined();
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
      pendingFinalDelivery: {
        kind: "replayable",
        text,
        context: {
          channel: "discord",
          to: "discord:dm:123",
          accountId: "main",
        },
      },
    });
  });

  it.each([
    ["restart-during-compaction", "reply owned by restart recovery"],
    ["restart-after-successful-compaction", "reply owned by restart recovery after compaction"],
    ["stale-during-compaction", "reply owned by the next gateway lifecycle"],
  ] as const)("does not deliver or clear the pending final for %s", async (sessionId, text) => {
    const restart = sessionId !== "stale-during-compaction";
    const sessionKey = `agent:main:explicit:${sessionId}`;
    const abortController = new AbortController();
    state.runAgentAttemptMock.mockResolvedValueOnce(makeResult({ sessionId, text }));
    state.runCliTurnCompactionLifecycleMock.mockImplementationOnce(async (params) => {
      expect(params.sessionEntry).toMatchObject({
        pendingFinalDelivery: { kind: "replayable", text },
      });
      if (restart) {
        abortController.abort(createAgentRunRestartAbortError());
      } else {
        rotateAgentEventLifecycleGeneration();
      }
      if (sessionId === "restart-after-successful-compaction") {
        return params.sessionEntry;
      }
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
    ).rejects.toThrow(
      restart ? "agent run aborted for restart" : "Agent run belongs to a stale gateway lifecycle",
    );

    expect(state.deliverAgentCommandResultMock).not.toHaveBeenCalled();
    expect(findStoredSessionEntry(sessionKey)).toMatchObject({
      pendingFinalDelivery: { kind: "replayable", text },
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
      expect(readLifecyclePhases()).toContain("error");
    },
  );

  it("compacts after persisting transport ownership for finals that text cannot replay", async () => {
    const sessionId = "unrecoverable-media-before-compaction";
    const sessionKey = `agent:main:explicit:${sessionId}`;
    const payloads = [{ mediaUrl: "/tmp/reply.ogg", audioAsVoice: true }];
    state.runAgentAttemptMock.mockResolvedValueOnce(makeResult({ sessionId, text: "", payloads }));

    await agentCommand({
      message: "room message",
      sessionId,
      sessionKey,
      cwd: state.workspaceDir,
      channel: "discord",
      to: "discord:dm:123",
      accountId: "main",
      deliver: true,
    });

    expect(state.runCliTurnCompactionLifecycleMock).toHaveBeenCalledOnce();
    expect(state.deliverAgentCommandResultMock).toHaveBeenCalledWith(
      expect.objectContaining({ payloads }),
    );
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
  });

  it("keeps post-turn compaction for no-delivery runs with unrecoverable sendable finals", async () => {
    const sessionId = "unrecoverable-media-no-delivery";
    const sessionKey = `agent:main:explicit:${sessionId}`;
    const payloads = [{ mediaUrl: "/tmp/reply.ogg", audioAsVoice: true }];
    const successor = { sessionId: "unrecoverable-media-post-flush" } as SessionEntry;
    state.runAgentAttemptMock.mockResolvedValueOnce(makeResult({ sessionId, text: "", payloads }));
    const flush = state.runMemoryFlushIfNeededMock;
    flush.mockResolvedValueOnce({ sessionEntry: successor, outcome: "completed" });

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

    const compaction = state.runCliTurnCompactionLifecycleMock.mock.calls[0]?.[0];
    expect(compaction?.sessionId).toBe(successor.sessionId);
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
    const sessionKey = "agent:main:explicit:old-session";
    await replaceSessionEntry(
      { sessionKey, storePath },
      {
        sessionId: "rotated-session",
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
      | {
          sessionId?: string;
          sessionKey?: string;
          sessionTarget?: {
            agentId?: string;
            sessionId?: string;
            sessionKey?: string;
            storePath?: string;
          };
        }
      | undefined;
    expect(secondAttempt).toMatchObject({
      sessionId: "rotated-session",
      sessionKey,
    });
    expect(secondAttempt?.sessionTarget).toMatchObject({
      agentId: "main",
      sessionId: "rotated-session",
      sessionKey,
      storePath,
    });
    expect(state.deliveryFreshEntries.at(-1)).toMatchObject({
      sessionId: "rotated-session",
    });
    const persisted = Object.fromEntries(
      listSessionEntriesCore({ storePath }).map(({ entry, sessionKey: key }) => [key, entry]),
    );
    expect(persisted[sessionKey]).toMatchObject({
      sessionId: "rotated-session",
    });
  });
});
