import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { getAgentEventLifecycleGeneration } from "../../../infra/agent-events.js";
import { normalizeEmbeddedRunAttempt } from "./attempt-normalization.js";
import { applyEmbeddedAttemptSessionIdentity } from "./attempt-session-identity.js";
import { loadAttemptSessionEntryAfterQuotaMaintenance } from "./attempt-transcript-helpers.js";
import { createEmbeddedRunContextRecoveryState } from "./context-recovery-state.js";
import { createEmbeddedRunLaneController } from "./lane-controller.js";
import {
  assertAgentHarnessRunAdmission,
  buildContextEngineCompactionSessionTarget,
  resetNoRealConversationTokenSnapshot,
} from "./session-bootstrap.js";
import { createEmbeddedRunSessionPromptState } from "./session-prompt-state.js";

const sessionAccessorMocks = vi.hoisted(() => ({
  listSessionEntriesReadOnly: vi.fn(() => []),
  loadSessionEntry: vi.fn(),
  patchSessionEntryCore:
    vi.fn<typeof import("../../../config/sessions/session-accessor.js").patchSessionEntryCore>(),
  updateSessionEntry: vi.fn(async () => undefined),
}));

vi.mock("../../../config/sessions/session-accessor.js", () => ({
  ...sessionAccessorMocks,
  loadSessionEntryReadOnly: sessionAccessorMocks.loadSessionEntry,
}));

beforeEach(() => {
  sessionAccessorMocks.listSessionEntriesReadOnly.mockReset().mockReturnValue([]);
  sessionAccessorMocks.loadSessionEntry.mockReset();
  sessionAccessorMocks.patchSessionEntryCore.mockReset().mockResolvedValue(null);
  sessionAccessorMocks.updateSessionEntry.mockReset().mockResolvedValue(undefined);
});

it.each([0, 2])(
  "retains compaction facts when parent Stop arrives during persistence (%s ingress records)",
  async (recordedCompactionCount) => {
    const persistence = createDeferred();
    const controller = new AbortController();
    const generation = getAgentEventLifecycleGeneration();
    const params = {
      abortSignal: controller.signal,
      prompt: "Stop while persisting",
      runId: "normalization-stop",
      sessionId: "normalization-stop",
      sessionFile: "agent:main:normalization-stop",
      timeoutMs: 30_000,
      workspaceDir: "/tmp",
    };
    const laneController = createEmbeddedRunLaneController({
      getParams: () => params,
      getLifecycleGeneration: () => generation,
      initialQueuedLifecycleGeneration: generation,
      globalLane: "normalization-stop-global",
      sessionLane: "normalization-stop-session",
      setParams: vi.fn(),
      setLifecycleGeneration: vi.fn(),
    });
    const cancelled = new Error("cancelled while user persistence was pending");
    const contextRecoveryState = createEmbeddedRunContextRecoveryState();
    contextRecoveryState.autoCompactionCount = recordedCompactionCount;
    contextRecoveryState.lastCompactionTokensAfter = recordedCompactionCount > 0 ? 60 : undefined;
    // Cancellation exits before model normalization; only the completed-attempt boundary is live.
    const normalization = normalizeEmbeddedRunAttempt({
      runInput: {
        runParams: params,
        laneController,
      },
      preparedRuntime: { snapshot: () => ({}) },
      recordedCompactionCount,
      dispatchedAttempt: {
        rawAttempt: { compactionCount: 2, compactionTokensAfter: 40.9 },
      },
      sessionPromptState: {
        activePrompt: { persisted: true },
        waitForCurrentUserMessagePersistence: () => persistence.promise,
      },
      contextRecoveryState,
    } as never);

    controller.abort(cancelled);
    persistence.resolve();
    await expect(normalization).rejects.toBe(cancelled);
    expect(contextRecoveryState).toMatchObject({
      autoCompactionCount: 2,
      lastCompactionTokensAfter: recordedCompactionCount > 0 ? 60 : 40,
    });
  },
);

describe("buildContextEngineCompactionSessionTarget", () => {
  it("leaves the key absent when a marker has no stored mapping", () => {
    expect(
      buildContextEngineCompactionSessionTarget({
        sessionFile: "sqlite:main:marker-session:/tmp/sessions.json",
        sessionId: "stale-outer-session",
      }),
    ).toEqual({
      agentId: "main",
      sessionId: "marker-session",
      storePath: "/tmp/sessions.json",
    });
  });

  it("uses the configured default agent without inventing a session key", () => {
    expect(
      buildContextEngineCompactionSessionTarget({
        config: {
          agents: { list: [{ id: "main" }, { id: "worker", default: true }] },
          session: { store: "/tmp/{agentId}/sessions.json" },
        },
        sessionFile: "compat-session",
        sessionId: "compat-session",
      }),
    ).toEqual({
      agentId: "worker",
      sessionId: "compat-session",
      storePath: "/tmp/worker/sessions.json",
    });
  });

  it("uses the persisted fixed-store owner for a bare compaction key", () => {
    expect(
      buildContextEngineCompactionSessionTarget({
        config: {
          agents: {
            ownership: "explicit",
            defaults: { sessionStore: { agentId: "ops" } },
            entries: { ops: {}, research: {} },
          },
          session: { store: "/tmp/shared-sessions.json" },
        },
        sessionFile: "global",
        sessionId: "ops-session",
        sessionKey: "global",
      }),
    ).toMatchObject({
      agentId: "ops",
      sessionKey: "global",
      storePath: "/tmp/shared-sessions.json",
    });
  });

  it("rejects a partial target that conflicts with the fixed-store owner", () => {
    expect(() =>
      buildContextEngineCompactionSessionTarget({
        config: {
          agents: {
            ownership: "explicit",
            defaults: { sessionStore: { agentId: "ops" } },
            entries: { ops: {}, research: {} },
          },
          session: { store: "/tmp/shared-sessions.json" },
        },
        sessionFile: "global",
        sessionId: "ops-session",
        sessionKey: "global",
        sessionTarget: {
          agentId: "research",
          sessionId: "ops-session",
          sessionKey: "global",
        },
      }),
    ).toThrow(/belongs to "ops"/u);
  });

  it("preserves an adopted session id without inventing a session key", () => {
    expect(
      buildContextEngineCompactionSessionTarget({
        sessionFile: "",
        sessionId: "previous-session",
        sessionTarget: {
          agentId: "main",
          sessionId: "adopted-session",
          storePath: "/tmp/sessions.json",
        },
      }),
    ).toEqual({
      agentId: "main",
      sessionId: "adopted-session",
      storePath: "/tmp/sessions.json",
    });
  });
});

describe("fixed-store session bootstrap", () => {
  const config = {
    agents: {
      ownership: "explicit" as const,
      defaults: { sessionStore: { agentId: "ops" } },
      entries: { ops: {}, research: {} },
    },
    session: { store: "/tmp/shared-sessions.json" },
  };

  it.each([false, true])(
    "keeps the prepared reset target and its commit owner (closed=%s)",
    async (closeBeforeCommit) => {
      const sessionTarget = {
        agentId: "ops",
        sessionId: "ops-session",
        sessionKey: "global",
        storePath: "/tmp/explicit-openclaw-agent.sqlite",
      };
      const callerError = new Error("reset owner closed while waiting for commit");
      let closed = false;
      const assertActive = () => {
        if (closed) {
          throw callerError;
        }
      };
      sessionAccessorMocks.patchSessionEntryCore.mockImplementationOnce(
        async (_scope, _update, options) => {
          closed = closeBeforeCommit;
          options?.assertCommitAllowed?.();
          return null;
        },
      );

      const reset = resetNoRealConversationTokenSnapshot({ sessionTarget, assertActive });
      if (closeBeforeCommit) {
        await expect(reset).rejects.toBe(callerError);
      } else {
        await reset;
      }
      expect(sessionAccessorMocks.patchSessionEntryCore).toHaveBeenCalledWith(
        sessionTarget,
        expect.any(Function),
        expect.objectContaining({ skipMaintenance: true, assertCommitAllowed: assertActive }),
      );
    },
  );

  it("carries the persisted owner into harness admission", () => {
    assertAgentHarnessRunAdmission({
      config,
      sessionId: "ops-session",
      sessionKey: "global",
    } as never);

    expect(sessionAccessorMocks.loadSessionEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "ops",
        sessionKey: "global",
        storePath: "/tmp/shared-sessions.json",
      }),
    );
  });

  it("carries the resolved owner into quota-maintenance reads", async () => {
    sessionAccessorMocks.loadSessionEntry.mockReturnValueOnce({
      sessionId: "ops-session",
      updatedAt: 1,
    });

    await loadAttemptSessionEntryAfterQuotaMaintenance({
      agentId: "ops",
      sessionKey: "global",
      storePath: "/tmp/shared-sessions.json",
    });

    expect(sessionAccessorMocks.loadSessionEntry).toHaveBeenCalledWith({
      agentId: "ops",
      sessionKey: "global",
      storePath: "/tmp/shared-sessions.json",
    });
  });
});

describe("createEmbeddedRunSessionPromptState", () => {
  it("keeps the admitted writer fence private across context-engine target adoption", () => {
    const state = createEmbeddedRunSessionPromptState({
      runParams: {
        agentId: "main",
        prompt: "hello",
        runId: "run-b",
        sessionFile: "agent:main:main",
        sessionId: "session-before",
        sessionKey: "agent:main:main",
        sessionTarget: {
          agentId: "main",
          expectedLifecycleRevision: "revision-a",
          expectedWriterRunId: "run-b",
          sessionId: "session-before",
          sessionKey: "agent:main:main",
          storePath: "/tmp/sessions.json",
        },
        timeoutMs: 30_000,
        workspaceDir: "/tmp",
      } as never,
      lifecycleGeneration: "generation-a",
      resolvedSessionKey: "agent:main:main",
      sessionAgentId: "main",
    });

    state.sessionTarget = {
      agentId: "main",
      sessionId: "session-after",
      sessionKey: "agent:main:main",
      storePath: "/tmp/sessions.json",
    };

    expect(state.sessionTarget).not.toHaveProperty("expectedWriterRunId");
    expect(state.sessionWriterFence).toEqual({
      expectedLifecycleRevision: "revision-a",
      expectedWriterRunId: "run-b",
    });
  });
});

function promptState(storePath = "/tmp/sessions.json") {
  return {
    sessionId: "session-before",
    sessionFile: "agent:main:main",
    sessionTarget: {
      agentId: "main",
      sessionId: "session-before",
      sessionKey: "agent:main:main",
      storePath,
    },
    adoptSessionId: vi.fn(),
  };
}

describe("applyEmbeddedAttemptSessionIdentity", () => {
  it("rejects a legacy successor file that cannot map to SQLite", () => {
    const state = promptState();

    expect(() =>
      applyEmbeddedAttemptSessionIdentity({
        sessionPromptState: state,
        sessionIdUsed: "session-after",
        sessionFileUsed: "/tmp/session-after.jsonl",
      }),
    ).toThrow("successor files are unsupported");
    expect(state.adoptSessionId).not.toHaveBeenCalled();
    expect(state.sessionTarget).toMatchObject({ sessionId: "session-before" });
  });

  it("resolves a legacy SQLite marker successor", () => {
    const state = promptState();

    applyEmbeddedAttemptSessionIdentity({
      sessionPromptState: state,
      sessionIdUsed: "session-after",
      sessionFileUsed: "sqlite:main:session-after:/tmp/sessions.json",
    });

    expect(state.sessionTarget).toMatchObject({
      agentId: "main",
      sessionId: "session-after",
      sessionKey: "agent:main:main",
      storePath: "/tmp/sessions.json",
    });
  });

  it("rebinds a legacy SQLite marker successor over the retained active entry", () => {
    sessionAccessorMocks.loadSessionEntry.mockReturnValue({
      sessionId: "session-before",
      updatedAt: 1,
    });
    const state = promptState();

    applyEmbeddedAttemptSessionIdentity({
      sessionPromptState: state,
      sessionIdUsed: "session-after",
      sessionFileUsed: "sqlite:main:session-after:/tmp/sessions.json",
    });

    expect(state.sessionTarget).toEqual({
      agentId: "main",
      sessionId: "session-after",
      sessionKey: "agent:main:main",
      storePath: "/tmp/sessions.json",
    });
  });

  it("rejects a legacy marker successor already mapped to another key", () => {
    sessionAccessorMocks.loadSessionEntry.mockReturnValue({
      sessionId: "session-before",
      updatedAt: 1,
    });
    sessionAccessorMocks.listSessionEntriesReadOnly.mockReturnValue([
      {
        sessionKey: "agent:main:other",
        entry: { sessionId: "session-after", updatedAt: 2 },
      },
    ] as never);
    const state = promptState();

    expect(() =>
      applyEmbeddedAttemptSessionIdentity({
        sessionPromptState: state,
        sessionIdUsed: "session-after",
        sessionFileUsed: "sqlite:main:session-after:/tmp/sessions.json",
      }),
    ).toThrow("successor target changed the active session binding");
  });

  it("rejects a legacy SQLite marker outside the active store", () => {
    const state = promptState();

    expect(() =>
      applyEmbeddedAttemptSessionIdentity({
        sessionPromptState: state,
        sessionIdUsed: "session-after",
        sessionFileUsed: "sqlite:main:session-after:/tmp/other-sessions.json",
      }),
    ).toThrow("successor target changed the active session binding");
  });

  it.each(["sqlite:other:session-after:/tmp/sessions.json", "agent:other:main"])(
    "rejects a cross-agent legacy successor identity: %s",
    (sessionFileUsed) => {
      const state = promptState();

      expect(() =>
        applyEmbeddedAttemptSessionIdentity({
          sessionPromptState: state,
          sessionIdUsed: "session-after",
          sessionFileUsed,
        }),
      ).toThrow(/successor (identity is inconsistent|files are unsupported)/u);
    },
  );

  it("retargets an id-only successor without discarding its SQLite identity", () => {
    const state = promptState();

    applyEmbeddedAttemptSessionIdentity({
      sessionPromptState: state,
      sessionIdUsed: "session-after",
    });

    expect(state.sessionTarget).toMatchObject({ sessionId: "session-after" });
  });

  it("refreshes a legacy marker for an id-only successor", () => {
    const state = promptState();
    state.sessionFile = "sqlite:main:session-before:/tmp/sessions.json";

    applyEmbeddedAttemptSessionIdentity({
      sessionPromptState: state,
      sessionIdUsed: "session-after",
    });

    expect(state.sessionFile).toBe("sqlite:main:session-after:/tmp/sessions.json");
    expect(state.sessionTarget).toMatchObject({ sessionId: "session-after" });
  });
});
