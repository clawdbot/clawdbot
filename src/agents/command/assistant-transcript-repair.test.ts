/** Focused tests for durable assistant-transcript repair across turns and session rotation. */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setReplyPayloadMetadata } from "../../auto-reply/reply-payload.js";
import type { SessionEntry } from "../../config/sessions.js";
import {
  listSessionEntries,
  loadTranscriptEvents,
} from "../../config/sessions/session-accessor.js";
import type { appendExactAssistantMessageToSessionTranscript } from "../../config/sessions/transcript.runtime.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { EmbeddedAgentRunResult } from "../embedded-agent.js";
import type { loadManifestModelCatalog } from "../model-catalog.js";
import type { persistCliTurnTranscript } from "./attempt-execution.js";
import type { runAgentAttempt } from "./attempt-execution.runtime.js";
import type { persistAgentSession } from "./attempt-execution.shared.js";

type ProviderModelNormalizationParams = { provider: string; context: { modelId: string } };
type LoadManifestModelCatalogParams = Parameters<typeof loadManifestModelCatalog>[0];
type RunAgentAttempt = typeof runAgentAttempt;
type PersistCliTurnTranscript = typeof persistCliTurnTranscript;
type AppendExactAssistantMessage = typeof appendExactAssistantMessageToSessionTranscript;
type PersistSessionEntry = typeof persistAgentSession;
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
  persistCliTurnTranscriptMock: vi.fn(),
  persistCliTurnTranscriptReal: undefined as PersistCliTurnTranscript | undefined,
  appendExactAssistantMessageMock: vi.fn<AppendExactAssistantMessage>(),
  appendExactAssistantMessageReal: undefined as AppendExactAssistantMessage | undefined,
  persistSessionEntryMock: vi.fn<PersistSessionEntry>(),
  persistSessionEntryReal: undefined as PersistSessionEntry | undefined,
  deliveryFreshEntries: [] as Array<SessionEntry | undefined>,
}));

vi.mock("../../config/io.js", () => ({
  getRuntimeConfig: () => state.cfg,
  readConfigFileSnapshotForWrite: async () => ({ snapshot: { valid: false } }),
}));

vi.mock("../agent-runtime-config.js", () => ({
  resolveAgentRuntimeConfig: async () => ({
    loadedRaw: state.cfg,
    sourceConfig: state.cfg,
    cfg: state.cfg,
  }),
}));

vi.mock("../../plugins/plugin-metadata-snapshot.js", () => ({
  isPluginMetadataSnapshotCompatible: () => false,
  resolvePluginMetadataSnapshot: () => ({ plugins: [] }),
}));

vi.mock("../agent-scope.js", async () => {
  const actual = await vi.importActual<typeof import("../agent-scope.js")>("../agent-scope.js");
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

vi.mock("../model-catalog.js", () => ({
  loadManifestModelCatalog: (params: LoadManifestModelCatalogParams) =>
    state.loadManifestModelCatalogMock(params),
}));

vi.mock("../model-catalog.runtime.js", () => ({
  loadProviderScopedThinkingCatalog: vi.fn(async () => []),
  loadPreparedModelCatalogSnapshot: vi.fn(async () => ({
    entries: [],
    routeVariants: [],
  })),
}));

vi.mock("../provider-model-normalization.runtime.js", () => ({
  normalizeProviderModelIdWithRuntime: (params: {
    provider: string;
    context: { modelId: string };
  }) => state.normalizeProviderModelIdWithRuntimeMock(params),
}));

vi.mock("../harness/runtime-plugin.js", () => ({
  ensureSelectedAgentHarnessPlugin: vi.fn(async () => undefined),
}));

vi.mock("../runtime-plugins.js", () => ({
  withAgentPluginRegistry: ({ run }: { run: () => unknown }) => run(),
}));

vi.mock("../workspace.js", () => ({
  ensureAgentWorkspace: vi.fn(async () => undefined),
}));

vi.mock("../auth-profiles/store.js", async () => {
  const actual = await vi.importActual<typeof import("../auth-profiles/store.js")>(
    "../auth-profiles/store.js",
  );
  return {
    ...actual,
    ensureAuthProfileStore: () => ({ profiles: {} }),
    saveAuthProfileStore: vi.fn(),
    updateAuthProfileStoreWithLock: vi.fn(async () => ({ profiles: {} })),
  };
});

vi.mock("../../acp/control-plane/manager.js", () => ({
  getAcpSessionManager: () => ({
    resolveSession: () => null,
  }),
}));

vi.mock("../../skills/runtime/remote.js", () => ({
  getRemoteSkillEligibility: () => ({ enabled: false, reason: "test" }),
}));

vi.mock("../../skills/runtime/session-snapshot.js", () => ({
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

vi.mock("../exec-defaults.js", () => ({
  resolveNodeExecEligibility: () => ({ canExec: false }),
}));

vi.mock("../model-fallback-runner.js", () => ({
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

vi.mock("./attempt-execution.runtime.js", async () => {
  const actual = await vi.importActual<typeof import("./attempt-execution.runtime.js")>(
    "./attempt-execution.runtime.js",
  );
  return {
    ...actual,
    runAgentAttempt: (...args: Parameters<RunAgentAttempt>) => state.runAgentAttemptMock(...args),
    persistCliTurnTranscript: (...args: Parameters<typeof actual.persistCliTurnTranscript>) => {
      state.persistCliTurnTranscriptReal = actual.persistCliTurnTranscript;
      if (state.persistCliTurnTranscriptMock) {
        return state.persistCliTurnTranscriptMock(...args);
      }
      return actual.persistCliTurnTranscript(...args);
    },
  };
});

vi.mock("../../config/sessions/transcript.runtime.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../config/sessions/transcript.runtime.js")
  >("../../config/sessions/transcript.runtime.js");
  return {
    ...actual,
    appendExactAssistantMessageToSessionTranscript: (
      ...args: Parameters<typeof actual.appendExactAssistantMessageToSessionTranscript>
    ) => {
      state.appendExactAssistantMessageReal = actual.appendExactAssistantMessageToSessionTranscript;
      return state.appendExactAssistantMessageMock(...args);
    },
  };
});

vi.mock("./attempt-execution.shared.js", async () => {
  const actual = await vi.importActual<typeof import("./attempt-execution.shared.js")>(
    "./attempt-execution.shared.js",
  );
  return {
    ...actual,
    persistAgentSession: (...args: Parameters<typeof actual.persistAgentSession>) => {
      state.persistSessionEntryReal = actual.persistAgentSession;
      return state.persistSessionEntryMock(...args);
    },
  };
});

vi.mock("./cli-compaction.js", () => ({
  runCliTurnCompactionLifecycle: (params: CliCompactionParams) =>
    state.runCliTurnCompactionLifecycleMock(params),
}));

vi.mock("../../infra/agent-events.js", async () => {
  const actual = await vi.importActual<typeof import("../../infra/agent-events.js")>(
    "../../infra/agent-events.js",
  );
  return {
    ...actual,
    emitAgentEvent: (...args: Parameters<typeof actual.emitAgentEvent>) => {
      state.emitAgentEventMock(...args);
      return actual.emitAgentEvent(...args);
    },
  };
});

vi.mock("./delivery.runtime.js", () => ({
  deliverAgentCommandResult: (params: unknown) => state.deliverAgentCommandResultMock(params),
}));

let agentCommand: typeof import("../agent-command.js").agentCommand;

beforeAll(async () => {
  agentCommand = (await import("../agent-command.js")).agentCommand;
});

beforeEach(async () => {
  vi.clearAllMocks();
  state.runAgentAttemptMock.mockReset();
  state.loadManifestModelCatalogMock.mockReset();
  state.normalizeProviderModelIdWithRuntimeMock.mockReset();
  state.runCliTurnCompactionLifecycleMock.mockReset();
  state.deliverAgentCommandResultMock.mockReset();
  state.emitAgentEventMock.mockReset();
  state.persistCliTurnTranscriptMock.mockReset();
  state.appendExactAssistantMessageMock.mockReset();
  state.persistSessionEntryMock.mockReset();
  state.loadManifestModelCatalogMock.mockReturnValue([]);
  state.normalizeProviderModelIdWithRuntimeMock.mockImplementation(() => undefined);
  state.runCliTurnCompactionLifecycleMock.mockImplementation(
    async (params: CliCompactionParams) => params.sessionEntry,
  );
  state.persistCliTurnTranscriptMock.mockImplementation(
    async (...args: Parameters<PersistCliTurnTranscript>) =>
      state.persistCliTurnTranscriptReal?.(...args),
  );
  state.appendExactAssistantMessageMock.mockImplementation(
    async (...args: Parameters<AppendExactAssistantMessage>) =>
      state.appendExactAssistantMessageReal?.(...args) ?? {
        ok: false,
        reason: "missing real transcript append",
      },
  );
  state.persistSessionEntryMock.mockImplementation(
    async (...args: Parameters<PersistSessionEntry>) => state.persistSessionEntryReal?.(...args),
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
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-repair-e2e-"));
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
  text?: string;
  runner?: "cli" | "embedded";
  payloads?: EmbeddedAgentRunResult["payloads"];
}): EmbeddedAgentRunResult {
  return {
    payloads: params.payloads ?? (params.text ? [{ text: params.text }] : []),
    meta: {
      durationMs: 1,
      stopReason: "end_turn",
      executionTrace: {
        runner: params.runner ?? "embedded",
        fallbackUsed: false,
        winnerProvider: "openai",
        winnerModel: "gpt-5.5",
      },
      ...(params.text ? { finalAssistantVisibleText: params.text } : {}),
      agentMeta: {
        sessionId: params.sessionId,
        provider: "openai",
        model: "gpt-5.5",
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

async function readMessageSequence(params: {
  agentId: string;
  sessionId: string;
  storePath: string;
}): Promise<Array<{ role?: string; text: string }>> {
  return (await readSessionMessages(params)).map((message) => {
    const value = message as {
      role?: string;
      content?: string | Array<{ type?: string; text?: string }>;
    };
    const text = Array.isArray(value.content)
      ? value.content.map((part) => part.text ?? "").join("")
      : (value.content ?? "");
    return { role: value.role, text };
  });
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

describe("assistant transcript repair", () => {
  it("records the canonical payload fallback when transcript persistence fails", async () => {
    const sessionId = "transcript-write-failure";
    const sessionKey = `agent:main:explicit:${sessionId}`;
    state.runAgentAttemptMock.mockResolvedValueOnce(
      makeResult({
        sessionId,
        runner: "cli",
        payloads: [{ text: "first payload" }, { text: "second payload" }],
      }),
    );
    state.persistCliTurnTranscriptMock.mockRejectedValueOnce(
      new Error("simulated transcript table corruption"),
    );

    await agentCommand({ message: "first prompt", sessionId, sessionKey, cwd: state.workspaceDir });

    expect(findStoredSessionEntry(sessionKey)?.pendingTranscriptRepair).toEqual([
      expect.objectContaining({
        id: expect.any(String),
        text: "first payload\n\nsecond payload",
      }),
    ]);
  });

  it("repairs the prior assistant before the next model attempt", async () => {
    const sessionId = "transcript-repair-order";
    const sessionKey = `agent:main:explicit:${sessionId}`;
    state.runAgentAttemptMock.mockImplementationOnce(async (params) => {
      await params.userTurnTranscriptRecorder?.persistApproved();
      return makeResult({ sessionId, text: "assistant one", runner: "cli" });
    });
    state.persistCliTurnTranscriptMock.mockRejectedValueOnce(
      new Error("simulated transcript table corruption"),
    );
    await agentCommand({ message: "user one", sessionId, sessionKey, cwd: state.workspaceDir });

    state.runAgentAttemptMock.mockImplementationOnce(async (params) => {
      expect(
        await readMessageSequence({ agentId: "main", sessionId, storePath: requireStorePath() }),
      ).toEqual([
        { role: "user", text: "user one" },
        { role: "assistant", text: "assistant one" },
      ]);
      await params.userTurnTranscriptRecorder?.persistApproved();
      return makeResult({ sessionId, text: "assistant two", runner: "cli" });
    });
    await agentCommand({ message: "user two", sessionId, sessionKey, cwd: state.workspaceDir });

    expect(findStoredSessionEntry(sessionKey)?.pendingTranscriptRepair).toBeUndefined();
    expect(
      await readMessageSequence({ agentId: "main", sessionId, storePath: requireStorePath() }),
    ).toEqual([
      { role: "user", text: "user one" },
      { role: "assistant", text: "assistant one" },
      { role: "user", text: "user two" },
      { role: "assistant", text: "assistant two" },
    ]);
  });

  it("blocks a continuing turn while transcript repair storage is still unavailable", async () => {
    const sessionId = "transcript-repair-barrier";
    const sessionKey = `agent:main:explicit:${sessionId}`;
    state.runAgentAttemptMock.mockResolvedValueOnce(
      makeResult({ sessionId, text: "assistant one", runner: "cli" }),
    );
    state.persistCliTurnTranscriptMock.mockRejectedValueOnce(
      new Error("simulated transcript table corruption"),
    );
    await agentCommand({ message: "user one", sessionId, sessionKey, cwd: state.workspaceDir });

    state.appendExactAssistantMessageMock.mockResolvedValueOnce({
      ok: false,
      reason: "simulated transcript table corruption",
    });
    await expect(
      agentCommand({ message: "user two", sessionId, sessionKey, cwd: state.workspaceDir }),
    ).rejects.toThrow("pending transcript recovery");

    expect(state.runAgentAttemptMock).toHaveBeenCalledOnce();
    expect(findStoredSessionEntry(sessionKey)?.pendingTranscriptRepair).toHaveLength(1);
  });

  it("does not duplicate a repaired assistant when backlog cleanup retries", async () => {
    const sessionId = "transcript-repair-cleanup-retry";
    const sessionKey = `agent:main:explicit:${sessionId}`;
    const repairedText = "assistant one";
    state.runAgentAttemptMock.mockResolvedValueOnce(
      makeResult({ sessionId, text: repairedText, runner: "cli" }),
    );
    state.persistCliTurnTranscriptMock.mockRejectedValueOnce(
      new Error("simulated transcript table corruption"),
    );
    await agentCommand({ message: "user one", sessionId, sessionKey, cwd: state.workspaceDir });

    let cleanupFailureInjected = false;
    state.persistSessionEntryMock.mockImplementation(async (...args) => {
      const [params] = args;
      if (
        !cleanupFailureInjected &&
        params.initialEntry.pendingTranscriptRepair?.length &&
        params.entry.pendingTranscriptRepair === undefined
      ) {
        cleanupFailureInjected = true;
        throw new Error("simulated cleanup failure");
      }
      return state.persistSessionEntryReal?.(...args);
    });
    state.runAgentAttemptMock.mockResolvedValueOnce(
      makeResult({ sessionId, text: "assistant two", runner: "cli" }),
    );
    await agentCommand({ message: "user two", sessionId, sessionKey, cwd: state.workspaceDir });
    expect(cleanupFailureInjected).toBe(true);
    expect(findStoredSessionEntry(sessionKey)?.pendingTranscriptRepair).toHaveLength(1);

    state.runAgentAttemptMock.mockResolvedValueOnce(
      makeResult({ sessionId, text: "assistant three", runner: "cli" }),
    );
    await agentCommand({ message: "user three", sessionId, sessionKey, cwd: state.workspaceDir });

    expect(findStoredSessionEntry(sessionKey)?.pendingTranscriptRepair).toBeUndefined();
    const assistantTexts = (
      await readMessageSequence({ agentId: "main", sessionId, storePath: requireStorePath() })
    )
      .filter((message) => message.role === "assistant")
      .map((message) => message.text);
    expect(assistantTexts.filter((text) => text === repairedText)).toHaveLength(1);
  });

  it("does not queue a repair for a final owned by another transcript writer", async () => {
    const sessionId = "transcript-owner-boundary";
    const sessionKey = `agent:main:explicit:${sessionId}`;
    const text = "runtime-owned assistant final";
    state.runAgentAttemptMock.mockResolvedValueOnce(
      makeResult({
        sessionId,
        text,
        runner: "cli",
        payloads: [setReplyPayloadMetadata({ text }, { assistantTranscriptOwned: true })],
      }),
    );
    state.persistCliTurnTranscriptMock.mockRejectedValueOnce(
      new Error("simulated transcript table corruption"),
    );

    const result = await agentCommand({
      message: "first prompt",
      sessionId,
      sessionKey,
      cwd: state.workspaceDir,
      channel: "discord",
      to: "discord:dm:123",
      accountId: "main",
      deliver: true,
    });

    expect(result).toMatchObject({ deliverySucceeded: true });
    expect(findStoredSessionEntry(sessionKey)?.pendingTranscriptRepair).toBeUndefined();
  });

  it("re-appends a missing turn whose text matches an earlier assistant message", async () => {
    const sessionId = "transcript-repair-equal-tail";
    const sessionKey = `agent:main:explicit:${sessionId}`;
    const sameText = "OK";
    let persistFailuresRemaining = 0;
    state.persistCliTurnTranscriptMock.mockImplementation(
      async (...args: Parameters<PersistCliTurnTranscript>) => {
        if (persistFailuresRemaining > 0) {
          persistFailuresRemaining -= 1;
          throw new Error("simulated transcript table corruption");
        }
        return state.persistCliTurnTranscriptReal?.(...args);
      },
    );

    state.runAgentAttemptMock.mockResolvedValueOnce(
      makeResult({ sessionId, text: sameText, runner: "cli" }),
    );
    await agentCommand({
      message: "first prompt",
      sessionId,
      sessionKey,
      cwd: state.workspaceDir,
    });

    state.runAgentAttemptMock.mockResolvedValueOnce(
      makeResult({ sessionId, text: sameText, runner: "cli" }),
    );
    persistFailuresRemaining = 1;
    await agentCommand({
      message: "second prompt",
      sessionId,
      sessionKey,
      cwd: state.workspaceDir,
    });
    expect(findStoredSessionEntry(sessionKey)?.pendingTranscriptRepair).toHaveLength(1);

    state.runAgentAttemptMock.mockResolvedValueOnce(
      makeResult({ sessionId, text: "third turn reply", runner: "cli" }),
    );
    await agentCommand({
      message: "third prompt",
      sessionId,
      sessionKey,
      cwd: state.workspaceDir,
    });

    expect(findStoredSessionEntry(sessionKey)?.pendingTranscriptRepair).toBeUndefined();
    const assistantTexts = (
      await readMessageSequence({ agentId: "main", sessionId, storePath: requireStorePath() })
    )
      .filter((message) => message.role === "assistant")
      .map((message) => message.text);
    expect(assistantTexts.filter((text) => text === sameText)).toHaveLength(2);
  });

  it("does not carry an unavailable predecessor repair into a reset session", async () => {
    const now = Date.now();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    try {
      const predecessorSessionId = "reset-predecessor";
      const sessionKey = `agent:main:explicit:${predecessorSessionId}`;
      state.cfg!.session!.reset = { mode: "idle", idleMinutes: 1 };
      state.runAgentAttemptMock.mockResolvedValueOnce(
        makeResult({
          sessionId: predecessorSessionId,
          text: "missing predecessor reply",
          runner: "cli",
        }),
      );
      state.persistCliTurnTranscriptMock.mockRejectedValueOnce(
        new Error("simulated transcript table corruption"),
      );
      await agentCommand({
        message: "old user",
        sessionId: predecessorSessionId,
        sessionKey,
        cwd: state.workspaceDir,
      });

      vi.setSystemTime(now + 120_000);
      state.appendExactAssistantMessageMock.mockResolvedValueOnce({
        ok: false,
        reason: "simulated transcript table corruption",
      });
      state.runAgentAttemptMock.mockImplementationOnce(async (params) =>
        makeResult({ sessionId: params.sessionId, text: "fresh reply", runner: "cli" }),
      );
      await agentCommand({ message: "fresh user", sessionKey, cwd: state.workspaceDir });

      const successor = findStoredSessionEntry(sessionKey);
      expect(successor?.sessionId).not.toBe(predecessorSessionId);
      expect(successor?.pendingTranscriptRepair).toBeUndefined();
      expect(
        await readMessageSequence({
          agentId: "main",
          sessionId: successor!.sessionId,
          storePath: requireStorePath(),
        }),
      ).toEqual([
        { role: "user", text: "fresh user" },
        { role: "assistant", text: "fresh reply" },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });
});
