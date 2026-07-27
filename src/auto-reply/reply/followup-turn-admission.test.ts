import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../../config/sessions.js";
import type { FollowupRun } from "./queue.js";

const state = vi.hoisted(() => ({
  admitLifecycle: vi.fn(),
  admitReply: vi.fn(),
  buildPreflightFailureText: vi.fn(),
  loadEntry: vi.fn(),
  preflight: vi.fn(),
  recheckFallbackProbe: vi.fn(),
  refreshGoal: vi.fn(),
  resolveConfig: vi.fn(),
  resolveSendPolicy: vi.fn(),
  sendPolicy: "allow" as "allow" | "deny",
  shouldNotifyCompaction: false,
}));

vi.mock("./agent-runner-auto-fallback.js", () => ({
  resolveRunAfterAutoFallbackPrimaryProbeRecheck: (...args: unknown[]) =>
    state.recheckFallbackProbe(...args),
}));

vi.mock("./agent-runner-memory.js", () => ({
  runPreflightCompactionIfNeeded: (...args: unknown[]) => state.preflight(...args),
}));

vi.mock("./agent-runner-utils.js", () => ({
  resolveQueuedReplyExecutionConfig: (...args: unknown[]) => state.resolveConfig(...args),
  resolveQueuedReplyRuntimeConfig: (config: unknown) => config,
}));

vi.mock("./reply-turn-admission.js", () => ({
  admitReplyTurn: (...args: unknown[]) => state.admitReply(...args),
}));

vi.mock("./queue.js", () => ({
  admitFollowupRunLifecycle: (...args: unknown[]) => state.admitLifecycle(...args),
  isFollowupRunAborted: (run: FollowupRun) =>
    run.abortSignal?.aborted === true || run.queueAbortSignal?.aborted === true,
  resolveFollowupAbortSignal: (run: FollowupRun) => run.abortSignal ?? run.queueAbortSignal,
}));

vi.mock("../../config/sessions/session-accessor.js", () => ({
  loadSessionEntry: (...args: unknown[]) => state.loadEntry(...args),
}));

vi.mock("../../sessions/send-policy.js", () => ({
  resolveSendPolicy: (...args: unknown[]) => state.resolveSendPolicy(...args),
}));

vi.mock("./inbound-meta.js", () => ({
  refreshActiveGoalContext: (...args: unknown[]) => state.refreshGoal(...args),
}));

vi.mock("./compaction-notice.js", () => ({
  createCompactionNoticePayload: ({ phase }: { phase: string }) => ({ text: phase }),
  shouldNotifyUserAboutCompaction: () => state.shouldNotifyCompaction,
}));

vi.mock("./agent-runner-failure-reply.js", () => ({
  buildPreflightCompactionFailureText: (...args: unknown[]) =>
    state.buildPreflightFailureText(...args),
}));

const { admitFollowupTurn } = await import("./followup-turn-admission.js");

function createRun(overrides: Partial<FollowupRun> = {}): FollowupRun {
  return {
    prompt: "queued prompt",
    enqueuedAt: 1,
    run: {
      agentId: "agent",
      agentDir: "/tmp/agent",
      sessionId: "queued-session",
      sessionKey: "main",
      sessionFile: "/tmp/queued.jsonl",
      workspaceDir: "/tmp",
      config: {},
      provider: "anthropic",
      model: "claude",
      timeoutMs: 1_000,
      blockReplyBreak: "message_end",
    },
    ...overrides,
  };
}

function createOperation(sessionId = "queued-session") {
  return {
    sessionId,
    abortForRestart: vi.fn(() => true),
    retainFailureUntilComplete: vi.fn(),
    fail: vi.fn(),
    complete: vi.fn(),
    updateSessionId: vi.fn(),
  };
}

function createDefaults(overrides: Record<string, unknown> = {}) {
  return {
    typing: {} as never,
    typingMode: "never" as const,
    defaultModel: "claude",
    sessionKey: "main",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  state.sendPolicy = "allow";
  state.shouldNotifyCompaction = false;
  state.resolveSendPolicy.mockImplementation(() => state.sendPolicy);
  state.resolveConfig.mockImplementation(async (config) => config);
  state.buildPreflightFailureText.mockReturnValue("preflight failed");
  state.preflight.mockImplementation(async ({ sessionEntry }) => sessionEntry);
  state.recheckFallbackProbe.mockImplementation(({ run }) => run);
  state.admitLifecycle.mockResolvedValue(undefined);
  state.refreshGoal.mockImplementation((context) => context);
});

describe("admitFollowupTurn", () => {
  it("returns a closed deferral without adopting the queued source", async () => {
    state.admitReply.mockResolvedValue({ status: "skipped", reason: "active-run" });

    await expect(
      admitFollowupTurn({ queued: createRun(), defaults: createDefaults() }),
    ).resolves.toEqual({ kind: "deferred", reason: "active-run" });
    expect(state.admitLifecycle).not.toHaveBeenCalled();
  });

  it("stops after asynchronous source adoption aborts the aggregate owner", async () => {
    const controller = new AbortController();
    const operation = createOperation();
    state.admitReply.mockResolvedValue({ status: "owned", operation });
    state.admitLifecycle.mockImplementation(async () => controller.abort());

    await expect(
      admitFollowupTurn({
        queued: createRun({ queueAbortSignal: controller.signal }),
        defaults: createDefaults(),
      }),
    ).resolves.toMatchObject({ kind: "skipped", reason: "aborted", operation });
    expect(state.preflight).not.toHaveBeenCalled();
  });

  it("uses admission-time session generation, model lock, policy, and goal context", async () => {
    const operation = createOperation("admitted-session");
    const queuedEntry: SessionEntry = { sessionId: "queued-session", updatedAt: 1 };
    const admittedEntry: SessionEntry = {
      sessionId: "admitted-session",
      sessionFile: "/tmp/admitted.jsonl",
      modelSelectionLocked: true,
      updatedAt: 2,
    };
    const sessionStore = { main: queuedEntry };
    const onQueuedFollowupAdmitted = vi.fn(async () => {});
    state.admitReply.mockResolvedValue({ status: "owned", operation, sessionEntry: admittedEntry });
    state.loadEntry.mockReturnValue(admittedEntry);
    state.sendPolicy = "deny";
    state.refreshGoal.mockReturnValue({ text: "fresh goal" });
    state.preflight.mockImplementation(async ({ sessionEntry }) => sessionEntry);

    const result = await admitFollowupTurn({
      queued: createRun({
        currentInboundContext: { text: "stale goal" },
        originatingChatType: "group",
      }),
      defaults: createDefaults({
        sessionEntry: queuedEntry,
        sessionStore,
        storePath: "/tmp/sessions.json",
        opts: { onQueuedFollowupAdmitted },
      }),
    });

    expect(result.kind).toBe("admitted");
    if (result.kind === "admitted") {
      expect(result.turn.queued.run).toMatchObject({
        sessionId: "admitted-session",
        sessionFile: "sqlite:agent:admitted-session:/tmp/sessions.json",
        modelSelectionLocked: true,
      });
      expect(result.turn.currentInboundContext).toEqual({ text: "fresh goal" });
      expect(result.turn.sendPolicy).toBe("deny");
      expect(result.turn.session.current()).toBe(admittedEntry);
    }
    expect(onQueuedFollowupAdmitted).toHaveBeenCalledOnce();
    expect(operation.retainFailureUntilComplete).toHaveBeenCalledOnce();
    expect(state.resolveSendPolicy).toHaveBeenCalledWith(
      expect.objectContaining({ chatType: "group" }),
    );
  });

  it("settles presentation and releases the reply operation when dispatcher setup fails", async () => {
    const operation = createOperation();
    const failure = new Error("dispatcher reset failed");
    const onQueuedFollowupSettled = vi.fn(async () => {});
    state.admitReply.mockResolvedValue({ status: "owned", operation });

    await expect(
      admitFollowupTurn({
        queued: createRun(),
        defaults: createDefaults({
          opts: {
            onQueuedFollowupAdmitted: vi.fn(async () => {
              throw failure;
            }),
            onQueuedFollowupSettled,
          },
        }),
      }),
    ).rejects.toBe(failure);
    expect(onQueuedFollowupSettled).toHaveBeenCalledOnce();
    expect(operation.complete).toHaveBeenCalledOnce();
  });

  it("prefers the admitted snapshot over unchanged stale in-memory state", async () => {
    const operation = createOperation("admitted-session");
    const queuedEntry: SessionEntry = { sessionId: "queued-session", updatedAt: 1 };
    const admittedEntry: SessionEntry = {
      sessionId: "admitted-session",
      modelSelectionLocked: true,
      updatedAt: 2,
    };
    const sessionStore = { main: queuedEntry };
    state.admitReply.mockResolvedValue({ status: "owned", operation, sessionEntry: admittedEntry });
    state.preflight.mockImplementation(async ({ sessionEntry }) => sessionEntry);

    const result = await admitFollowupTurn({
      queued: createRun(),
      defaults: createDefaults({ sessionEntry: queuedEntry, sessionStore }),
    });

    expect(result).toMatchObject({
      kind: "admitted",
      turn: {
        queued: { run: { sessionId: "admitted-session", modelSelectionLocked: true } },
      },
    });
    if (result.kind === "admitted") {
      expect(result.turn.session.current()).toBe(admittedEntry);
    }
  });

  it("clears queued generation facts when only the lifecycle revision advances", async () => {
    const operation = createOperation();
    const queuedEntry: SessionEntry = {
      sessionId: "queued-session",
      lifecycleRevision: "queued-revision",
      updatedAt: 1,
    };
    const admittedEntry: SessionEntry = {
      ...queuedEntry,
      lifecycleRevision: "admitted-revision",
      updatedAt: 2,
    };
    const sessionStore = { main: queuedEntry };
    state.admitReply.mockResolvedValue({ status: "owned", operation, sessionEntry: admittedEntry });
    state.loadEntry.mockReturnValue(admittedEntry);
    const queued = createRun();
    queued.run.cliSessionBindingFacts = { provider: "claude-cli" } as never;
    queued.run.autoFallbackPrimaryProbe = { provider: "anthropic", model: "claude" } as never;

    const result = await admitFollowupTurn({
      queued,
      defaults: createDefaults({ sessionEntry: queuedEntry, sessionStore }),
    });

    expect(result.kind).toBe("admitted");
    if (result.kind === "admitted") {
      expect(result.turn.queued.run.cliSessionBindingFacts).toBeUndefined();
      expect(result.turn.queued.run.autoFallbackPrimaryProbe).toBeUndefined();
    }
  });

  it("does not pass stale enqueue-time state into a rotated session generation", async () => {
    const operation = createOperation("rotated-session");
    const staleEntry: SessionEntry = {
      sessionId: "queued-session",
      modelSelectionLocked: true,
      updatedAt: 1,
    };
    const sessionStore = { main: staleEntry };
    state.admitReply.mockResolvedValue({ status: "owned", operation });
    state.loadEntry.mockReturnValue(undefined);

    const result = await admitFollowupTurn({
      queued: createRun(),
      defaults: createDefaults({ sessionEntry: staleEntry, sessionStore }),
    });

    expect(result.kind).toBe("admitted");
    if (result.kind === "admitted") {
      expect(result.turn.queued.run.modelSelectionLocked).toBe(false);
    }
    expect(state.preflight).toHaveBeenCalledWith(
      expect.objectContaining({ sessionEntry: undefined }),
    );
    const preflightParams = state.preflight.mock.calls[0]?.[0] as {
      sessionStore?: Record<string, SessionEntry>;
    };
    expect(preflightParams.sessionStore?.main).toBeUndefined();
    expect(state.refreshGoal).toHaveBeenCalledWith(undefined, undefined);
  });

  it("restores the item when persisted state changes generation after admission", async () => {
    const operation = createOperation();
    const initialEntry: SessionEntry = { sessionId: "queued-session", updatedAt: 1 };
    const replacementEntry: SessionEntry = { sessionId: "replacement-session", updatedAt: 2 };
    state.admitReply.mockResolvedValue({ status: "owned", operation, sessionEntry: initialEntry });
    state.loadEntry.mockReturnValue(replacementEntry);

    await expect(
      admitFollowupTurn({
        queued: createRun(),
        defaults: createDefaults({ sessionEntry: initialEntry, storePath: "/tmp/sessions.json" }),
      }),
    ).rejects.toThrow("Follow-up session generation changed after reply admission");
    expect(operation.complete).toHaveBeenCalledOnce();
    expect(state.preflight).not.toHaveBeenCalled();
  });

  it("restores the item when persisted lifecycle revision changes after admission", async () => {
    const operation = createOperation();
    const initialEntry: SessionEntry = {
      sessionId: "queued-session",
      lifecycleRevision: "admitted",
      updatedAt: 1,
    };
    const replacementEntry: SessionEntry = {
      ...initialEntry,
      lifecycleRevision: "replacement",
      updatedAt: 2,
    };
    state.admitReply.mockResolvedValue({ status: "owned", operation, sessionEntry: initialEntry });
    state.loadEntry.mockReturnValue(replacementEntry);

    await expect(
      admitFollowupTurn({
        queued: createRun(),
        defaults: createDefaults({ sessionEntry: initialEntry, storePath: "/tmp/sessions.json" }),
      }),
    ).rejects.toThrow("Follow-up session generation changed after reply admission");
    expect(operation.complete).toHaveBeenCalledOnce();
    expect(state.preflight).not.toHaveBeenCalled();
  });

  it("restores the item when an in-memory generation changes while admission awaits", async () => {
    const operation = createOperation();
    const initialEntry: SessionEntry = {
      sessionId: "queued-session",
      lifecycleRevision: "admitted",
      updatedAt: 1,
    };
    const replacementEntry: SessionEntry = {
      sessionId: "replacement-session",
      lifecycleRevision: "replacement",
      updatedAt: 2,
    };
    const sessionStore = { main: initialEntry };
    state.admitReply.mockResolvedValue({ status: "owned", operation, sessionEntry: initialEntry });
    const onQueuedFollowupAdmitted = vi.fn(async () => {
      sessionStore.main = replacementEntry;
    });

    await expect(
      admitFollowupTurn({
        queued: createRun(),
        defaults: createDefaults({
          sessionEntry: initialEntry,
          sessionStore,
          opts: { onQueuedFollowupAdmitted },
        }),
      }),
    ).rejects.toThrow("Follow-up session generation changed after reply admission");
    expect(operation.complete).toHaveBeenCalledOnce();
    expect(state.preflight).not.toHaveBeenCalled();
  });

  it("restores the item when the admitted persisted generation disappears", async () => {
    const operation = createOperation();
    const initialEntry: SessionEntry = { sessionId: "queued-session", updatedAt: 1 };
    state.admitReply.mockResolvedValue({ status: "owned", operation, sessionEntry: initialEntry });
    state.loadEntry.mockReturnValue(undefined);

    await expect(
      admitFollowupTurn({
        queued: createRun(),
        defaults: createDefaults({ sessionEntry: initialEntry, storePath: "/tmp/sessions.json" }),
      }),
    ).rejects.toThrow("Follow-up session generation changed after reply admission");
    expect(operation.complete).toHaveBeenCalledOnce();
    expect(state.preflight).not.toHaveBeenCalled();
  });

  it("advances the owned lifecycle generation only through explicit adoption", async () => {
    const operation = createOperation();
    const initialEntry: SessionEntry = {
      sessionId: "queued-session",
      lifecycleRevision: "revision-a",
      updatedAt: 1,
    };
    const sessionStore = { main: initialEntry };
    state.admitReply.mockResolvedValue({ status: "owned", operation, sessionEntry: initialEntry });
    state.loadEntry.mockReturnValue(initialEntry);
    const result = await admitFollowupTurn({
      queued: createRun(),
      defaults: createDefaults({ sessionEntry: initialEntry, sessionStore }),
    });

    expect(result.kind).toBe("admitted");
    if (result.kind === "admitted") {
      const replacement = {
        ...initialEntry,
        lifecycleRevision: "revision-b",
        updatedAt: 2,
      };
      result.turn.session.adopt(replacement);
      result.turn.session.publish(initialEntry);
      expect(result.turn.session.current()).toBe(replacement);
      const newerSameGeneration = {
        ...replacement,
        updatedAt: 4,
      };
      result.turn.session.adopt(newerSameGeneration);
      result.turn.session.publish(replacement);
      expect(result.turn.session.current()).toBe(newerSameGeneration);

      const concurrentEntry = {
        ...initialEntry,
        lifecycleRevision: "revision-c",
        updatedAt: 3,
      };
      sessionStore.main = concurrentEntry;
      result.turn.session.publish(replacement);
      expect(sessionStore.main).toBe(concurrentEntry);
    }
  });

  it("does not treat an absent admitted lifecycle revision as a wildcard", async () => {
    const operation = createOperation();
    const initialEntry: SessionEntry = { sessionId: "queued-session", updatedAt: 1 };
    const sessionStore = { main: initialEntry };
    state.admitReply.mockResolvedValue({ status: "owned", operation, sessionEntry: initialEntry });
    state.loadEntry.mockReturnValue(initialEntry);

    const result = await admitFollowupTurn({
      queued: createRun(),
      defaults: createDefaults({ sessionEntry: initialEntry, sessionStore }),
    });

    expect(result.kind).toBe("admitted");
    if (result.kind === "admitted") {
      sessionStore.main = {
        ...initialEntry,
        lifecycleRevision: "replacement",
        updatedAt: 2,
      };
      expect(result.turn.session.current()).toBe(initialEntry);
    }
  });

  it("does not republish a generation deleted after admission", async () => {
    const operation = createOperation();
    const initialEntry: SessionEntry = {
      sessionId: "queued-session",
      lifecycleRevision: "admitted",
      updatedAt: 1,
    };
    const sessionStore: Record<string, SessionEntry> = { main: initialEntry };
    state.admitReply.mockResolvedValue({ status: "owned", operation, sessionEntry: initialEntry });

    const result = await admitFollowupTurn({
      queued: createRun(),
      defaults: createDefaults({ sessionEntry: initialEntry, sessionStore }),
    });

    expect(result.kind).toBe("admitted");
    if (result.kind === "admitted") {
      delete sessionStore.main;
      result.turn.session.publish({ ...initialEntry, updatedAt: 2 });
      expect(sessionStore.main).toBeUndefined();
    }
  });

  it("creates an owned session-store view when only persisted state is available", async () => {
    const operation = createOperation();
    const admittedEntry: SessionEntry = { sessionId: "queued-session", updatedAt: 1 };
    state.admitReply.mockResolvedValue({ status: "owned", operation, sessionEntry: admittedEntry });
    state.loadEntry.mockReturnValue(admittedEntry);

    const result = await admitFollowupTurn({
      queued: createRun(),
      defaults: createDefaults({ storePath: "/tmp/sessions.json" }),
    });

    expect(result.kind).toBe("admitted");
    if (result.kind === "admitted") {
      expect(result.turn.sessionStore?.main).toBe(admittedEntry);
      const updated = { ...admittedEntry, compactionCount: 1, updatedAt: 2 };
      result.turn.sessionStore!.main = updated;
      expect(result.turn.session.current()).toBe(updated);
    }
  });

  it("synchronizes a fresh admitted snapshot over same-generation stale memory", async () => {
    const operation = createOperation();
    const staleEntry: SessionEntry = {
      sessionId: "queued-session",
      lifecycleRevision: "revision-a",
      verboseLevel: "off",
      updatedAt: 1,
    };
    const freshEntry: SessionEntry = {
      ...staleEntry,
      verboseLevel: "full",
      updatedAt: 2,
    };
    const sessionStore = { main: staleEntry };
    state.admitReply.mockResolvedValue({ status: "owned", operation, sessionEntry: freshEntry });
    state.loadEntry.mockReturnValue(freshEntry);

    const result = await admitFollowupTurn({
      queued: createRun(),
      defaults: createDefaults({ sessionStore, sessionEntry: staleEntry }),
    });

    expect(result.kind).toBe("admitted");
    if (result.kind === "admitted") {
      expect(result.turn.session.current()).toBe(freshEntry);
      expect(sessionStore.main).toBe(freshEntry);
    }
    expect(state.refreshGoal).toHaveBeenCalledWith(undefined, freshEntry);
    expect(state.recheckFallbackProbe).toHaveBeenCalledWith(
      expect.objectContaining({ entry: freshEntry, sessionKey: "main" }),
    );
  });

  it("adopts a session generation rotated by owned preflight compaction", async () => {
    const operation = createOperation();
    const initialEntry: SessionEntry = { sessionId: "queued-session", updatedAt: 1 };
    const rotatedEntry: SessionEntry = {
      sessionId: "compacted-session",
      updatedAt: 2,
    };
    const sessionStore = { main: initialEntry };
    state.admitReply.mockResolvedValue({ status: "owned", operation, sessionEntry: initialEntry });
    state.loadEntry.mockReturnValue(initialEntry);
    state.preflight.mockResolvedValue(rotatedEntry);

    const queued = createRun();
    queued.run.cliSessionBindingFacts = { provider: "claude-cli" } as never;
    queued.run.autoFallbackPrimaryProbe = { provider: "anthropic", model: "claude" } as never;
    queued.run.modelSelectionLocked = true;
    const result = await admitFollowupTurn({
      queued,
      defaults: createDefaults({ sessionStore, sessionEntry: initialEntry }),
    });

    expect(result.kind).toBe("admitted");
    if (result.kind === "admitted") {
      expect(result.turn.session.current()).toBe(rotatedEntry);
      expect(result.turn.queued.run).toMatchObject({
        sessionId: "compacted-session",
        modelSelectionLocked: false,
      });
      expect(result.turn.queued.run.sessionFile).toContain("compacted-session");
      expect(result.turn.queued.run.sessionFile).not.toBe("/tmp/session.jsonl");
      expect(result.turn.queued.run.cliSessionBindingFacts).toBeUndefined();
      expect(result.turn.queued.run.autoFallbackPrimaryProbe).toBeUndefined();
      expect(result.turn.preflightCompactionApplied).toBe(true);
    }
    expect(operation.updateSessionId).toHaveBeenCalledWith("compacted-session");
  });

  it("adopts a generation already published by owned preflight compaction", async () => {
    const operation = createOperation();
    const initialEntry: SessionEntry = {
      sessionId: "queued-session",
      lifecycleRevision: "initial",
      updatedAt: 1,
    };
    const rotatedEntry: SessionEntry = {
      sessionId: "compacted-session",
      lifecycleRevision: "compacted",
      updatedAt: 2,
    };
    const publishedEntry: SessionEntry = {
      ...rotatedEntry,
      verboseLevel: "full",
      updatedAt: 3,
    };
    const sessionStore = { main: initialEntry };
    state.admitReply.mockResolvedValue({ status: "owned", operation, sessionEntry: initialEntry });
    state.loadEntry.mockReturnValue(initialEntry);
    state.preflight.mockImplementation(async () => {
      sessionStore.main = publishedEntry;
      return rotatedEntry;
    });

    const result = await admitFollowupTurn({
      queued: createRun(),
      defaults: createDefaults({ sessionStore, sessionEntry: initialEntry }),
    });

    expect(result).toMatchObject({ kind: "admitted" });
    if (result.kind === "admitted") {
      expect(result.turn.session.current()).toBe(publishedEntry);
    }
    expect(state.resolveSendPolicy).toHaveBeenLastCalledWith(
      expect.objectContaining({ entry: publishedEntry }),
    );
  });

  it("adopts a generation written through the owned preflight store view", async () => {
    const operation = createOperation();
    const initialEntry: SessionEntry = {
      sessionId: "queued-session",
      lifecycleRevision: "initial",
      updatedAt: 1,
    };
    const rotatedEntry: SessionEntry = {
      sessionId: "compacted-session",
      lifecycleRevision: "compacted",
      updatedAt: 2,
    };
    const sessionStore = { main: initialEntry };
    state.admitReply.mockResolvedValue({ status: "owned", operation, sessionEntry: initialEntry });
    state.preflight.mockImplementation(
      async ({ sessionStore: ownedStore }: { sessionStore: Record<string, SessionEntry> }) => {
        ownedStore.main = rotatedEntry;
        return ownedStore.main;
      },
    );

    const result = await admitFollowupTurn({
      queued: createRun(),
      defaults: createDefaults({ sessionEntry: initialEntry, sessionStore }),
    });

    expect(result).toMatchObject({
      kind: "admitted",
      turn: { queued: { run: { sessionId: "compacted-session" } } },
    });
    expect(sessionStore.main).toBe(rotatedEntry);
  });

  it("forwards owned preflight deletion to the backing session store", async () => {
    const operation = createOperation();
    const initialEntry: SessionEntry = { sessionId: "queued-session", updatedAt: 1 };
    const sessionStore: Record<string, SessionEntry> = { main: initialEntry };
    state.admitReply.mockResolvedValue({ status: "owned", operation, sessionEntry: initialEntry });
    state.preflight.mockImplementation(
      async ({ sessionStore: ownedStore }: { sessionStore: Record<string, SessionEntry> }) => {
        delete ownedStore.main;
        return initialEntry;
      },
    );

    await expect(
      admitFollowupTurn({
        queued: createRun(),
        defaults: createDefaults({ sessionEntry: initialEntry, sessionStore }),
      }),
    ).rejects.toThrow("Follow-up session generation changed");
    expect(sessionStore.main).toBeUndefined();
    expect(operation.complete).toHaveBeenCalledOnce();
  });

  it("restores the item when preflight adoption races a replacement generation", async () => {
    const operation = createOperation();
    const initialEntry: SessionEntry = {
      sessionId: "queued-session",
      lifecycleRevision: "initial",
      updatedAt: 1,
    };
    const rotatedEntry: SessionEntry = {
      sessionId: "compacted-session",
      lifecycleRevision: "compacted",
      updatedAt: 2,
    };
    const replacementEntry: SessionEntry = {
      sessionId: "replacement-session",
      lifecycleRevision: "replacement",
      updatedAt: 3,
    };
    const sessionStore = { main: initialEntry };
    state.admitReply.mockResolvedValue({ status: "owned", operation, sessionEntry: initialEntry });
    state.loadEntry.mockReturnValue(initialEntry);
    state.preflight.mockImplementation(async () => {
      sessionStore.main = replacementEntry;
      return rotatedEntry;
    });

    await expect(
      admitFollowupTurn({
        queued: createRun(),
        defaults: createDefaults({ sessionStore, sessionEntry: initialEntry }),
      }),
    ).rejects.toThrow("Follow-up session generation changed");
    expect(operation.complete).toHaveBeenCalledOnce();
    expect(state.buildPreflightFailureText).not.toHaveBeenCalled();
  });

  it("restores the item when a no-op preflight observes a replacement generation", async () => {
    const operation = createOperation();
    const initialEntry: SessionEntry = {
      sessionId: "queued-session",
      lifecycleRevision: "initial",
      updatedAt: 1,
    };
    const replacementEntry: SessionEntry = {
      sessionId: "replacement-session",
      lifecycleRevision: "replacement",
      updatedAt: 2,
    };
    const sessionStore = { main: initialEntry };
    state.admitReply.mockResolvedValue({ status: "owned", operation, sessionEntry: initialEntry });
    state.loadEntry.mockReturnValue(initialEntry);
    state.preflight.mockImplementation(async () => {
      sessionStore.main = replacementEntry;
      return initialEntry;
    });

    await expect(
      admitFollowupTurn({
        queued: createRun(),
        defaults: createDefaults({ sessionStore, sessionEntry: initialEntry }),
      }),
    ).rejects.toThrow("Follow-up session generation changed");
    expect(operation.complete).toHaveBeenCalledOnce();
  });

  it("restores the item when a successful preflight observes in-memory deletion", async () => {
    const operation = createOperation();
    const initialEntry: SessionEntry = {
      sessionId: "queued-session",
      lifecycleRevision: "initial",
      updatedAt: 1,
    };
    const sessionStore: Record<string, SessionEntry> = { main: initialEntry };
    state.admitReply.mockResolvedValue({ status: "owned", operation, sessionEntry: initialEntry });
    state.preflight.mockImplementation(async () => {
      delete sessionStore.main;
      return initialEntry;
    });

    await expect(
      admitFollowupTurn({
        queued: createRun(),
        defaults: createDefaults({ sessionStore, sessionEntry: initialEntry }),
      }),
    ).rejects.toThrow("Follow-up session generation changed");
    expect(operation.complete).toHaveBeenCalledOnce();
  });

  it("refreshes send policy and goal context after preflight rotates the generation", async () => {
    const operation = createOperation();
    const initialEntry: SessionEntry = { sessionId: "queued-session", updatedAt: 1 };
    const rotatedEntry: SessionEntry = { sessionId: "compacted-session", updatedAt: 2 };
    const sessionStore = { main: initialEntry };
    state.admitReply.mockResolvedValue({ status: "owned", operation, sessionEntry: initialEntry });
    state.loadEntry.mockReturnValue(initialEntry);
    state.refreshGoal.mockImplementation((_context, entry) => ({ text: entry?.sessionId }));
    state.preflight.mockImplementation(async () => {
      state.sendPolicy = "deny";
      return rotatedEntry;
    });

    const result = await admitFollowupTurn({
      queued: createRun({ currentInboundContext: { text: "stale" } }),
      defaults: createDefaults({ sessionStore, sessionEntry: initialEntry }),
    });

    expect(result).toMatchObject({
      kind: "admitted",
      turn: {
        sendPolicy: "deny",
        currentInboundContext: { text: "compacted-session" },
        queued: { currentInboundContext: { text: "compacted-session" } },
      },
    });
  });

  it("rechecks send policy before an in-preflight compaction notice", async () => {
    const operation = createOperation();
    const initialEntry: SessionEntry = { sessionId: "queued-session", updatedAt: 1 };
    const deniedEntry: SessionEntry = { ...initialEntry, updatedAt: 2 };
    const onCompactionNoticePayload = vi.fn(async () => {});
    state.shouldNotifyCompaction = true;
    state.admitReply.mockResolvedValue({ status: "owned", operation, sessionEntry: initialEntry });
    state.loadEntry.mockReturnValueOnce(initialEntry).mockReturnValue(deniedEntry);
    state.resolveSendPolicy.mockImplementation(({ entry }) =>
      entry === deniedEntry ? "deny" : "allow",
    );
    state.preflight.mockImplementation(async ({ onCompactionNotice }) => {
      await onCompactionNotice?.("end");
      return deniedEntry;
    });

    await admitFollowupTurn({
      queued: createRun(),
      defaults: createDefaults({ sessionEntry: initialEntry, storePath: "/tmp/sessions.json" }),
      onCompactionNoticePayload,
    });

    expect(onCompactionNoticePayload).not.toHaveBeenCalled();
    expect(state.resolveSendPolicy).toHaveBeenLastCalledWith(
      expect.objectContaining({ entry: deniedEntry }),
    );
  });

  it("delivers a terminal compaction notice after adopting its rotated generation", async () => {
    const operation = createOperation();
    const initialEntry: SessionEntry = {
      sessionId: "queued-session",
      lifecycleRevision: "initial",
      updatedAt: 1,
    };
    const rotatedEntry: SessionEntry = {
      sessionId: "compacted-session",
      lifecycleRevision: "compacted",
      updatedAt: 2,
    };
    const sessionStore = { main: initialEntry };
    const onCompactionNoticePayload = vi.fn(async () => {});
    state.shouldNotifyCompaction = true;
    state.admitReply.mockResolvedValue({ status: "owned", operation, sessionEntry: initialEntry });
    state.preflight.mockImplementation(async ({ onCompactionNotice }) => {
      sessionStore.main = rotatedEntry;
      await onCompactionNotice?.("end");
      return rotatedEntry;
    });

    const result = await admitFollowupTurn({
      queued: createRun(),
      defaults: createDefaults({ sessionEntry: initialEntry, sessionStore }),
      onCompactionNoticePayload,
    });

    expect(result).toMatchObject({ kind: "admitted" });
    expect(onCompactionNoticePayload).toHaveBeenCalledWith(
      { text: "end" },
      expect.objectContaining({
        sendPolicy: "allow",
        queued: expect.objectContaining({
          run: expect.objectContaining({ sessionId: "compacted-session" }),
        }),
      }),
    );
  });

  it("releases the admitted operation when deferred terminal notice delivery fails", async () => {
    const operation = createOperation();
    const initialEntry: SessionEntry = { sessionId: "queued-session", updatedAt: 1 };
    const failure = new Error("notice delivery failed");
    state.shouldNotifyCompaction = true;
    state.admitReply.mockResolvedValue({ status: "owned", operation, sessionEntry: initialEntry });
    state.preflight.mockImplementation(async ({ onCompactionNotice }) => {
      await onCompactionNotice?.("end");
      return initialEntry;
    });

    await expect(
      admitFollowupTurn({
        queued: createRun(),
        defaults: createDefaults({ sessionEntry: initialEntry }),
        onCompactionNoticePayload: vi.fn(async () => {
          throw failure;
        }),
      }),
    ).rejects.toBe(failure);
    expect(operation.complete).toHaveBeenCalledOnce();
  });

  it("delivers an incomplete terminal notice after ordinary preflight failure", async () => {
    const operation = createOperation();
    const initialEntry: SessionEntry = { sessionId: "queued-session", updatedAt: 1 };
    const onCompactionNoticePayload = vi.fn(async () => {});
    state.shouldNotifyCompaction = true;
    state.admitReply.mockResolvedValue({ status: "owned", operation, sessionEntry: initialEntry });
    state.preflight.mockImplementation(async ({ onCompactionNotice }) => {
      await onCompactionNotice?.("start");
      await onCompactionNotice?.("incomplete");
      throw new Error("preflight failed");
    });

    const result = await admitFollowupTurn({
      queued: createRun(),
      defaults: createDefaults({ sessionEntry: initialEntry }),
      onCompactionNoticePayload,
    });

    expect(result).toMatchObject({ kind: "admitted", turn: { preflightFailurePayload: {} } });
    expect(onCompactionNoticePayload).toHaveBeenCalledTimes(2);
    expect(onCompactionNoticePayload).toHaveBeenNthCalledWith(
      1,
      { text: "start" },
      expect.anything(),
    );
    expect(onCompactionNoticePayload).toHaveBeenNthCalledWith(
      2,
      { text: "incomplete" },
      expect.anything(),
    );
  });

  it("keeps an owned preflight rotation when preflight later fails", async () => {
    const operation = createOperation();
    const initialEntry: SessionEntry = {
      sessionId: "queued-session",
      lifecycleRevision: "initial",
      updatedAt: 1,
    };
    const rotatedEntry: SessionEntry = {
      sessionId: "compacted-session",
      lifecycleRevision: "compacted",
      updatedAt: 2,
    };
    const sessionStore = { main: initialEntry };
    state.admitReply.mockResolvedValue({ status: "owned", operation, sessionEntry: initialEntry });
    state.preflight.mockImplementation(
      async ({ sessionStore: ownedStore }: { sessionStore: Record<string, SessionEntry> }) => {
        ownedStore.main = rotatedEntry;
        throw new Error("preflight failed after rotation");
      },
    );

    const result = await admitFollowupTurn({
      queued: createRun(),
      defaults: createDefaults({ sessionEntry: initialEntry, sessionStore }),
    });

    expect(result).toMatchObject({
      kind: "admitted",
      turn: {
        queued: { run: { sessionId: "compacted-session" } },
        preflightFailurePayload: {},
      },
    });
    expect(operation.updateSessionId).toHaveBeenCalledWith("compacted-session");
  });

  it("restores the item when generation changes before a compaction notice", async () => {
    const operation = createOperation();
    const initialEntry: SessionEntry = { sessionId: "queued-session", updatedAt: 1 };
    const replacementEntry: SessionEntry = { sessionId: "replacement-session", updatedAt: 2 };
    const onCompactionNoticePayload = vi.fn(async () => {});
    state.shouldNotifyCompaction = true;
    state.admitReply.mockResolvedValue({ status: "owned", operation, sessionEntry: initialEntry });
    state.loadEntry.mockReturnValueOnce(initialEntry).mockReturnValue(replacementEntry);
    state.preflight.mockImplementation(async ({ onCompactionNotice }) => {
      await onCompactionNotice?.("end");
      return initialEntry;
    });

    await expect(
      admitFollowupTurn({
        queued: createRun(),
        defaults: createDefaults({ sessionEntry: initialEntry, storePath: "/tmp/sessions.json" }),
        onCompactionNoticePayload,
      }),
    ).rejects.toThrow("Follow-up session generation changed");
    expect(onCompactionNoticePayload).not.toHaveBeenCalled();
    expect(operation.complete).toHaveBeenCalledOnce();
  });

  it("cancels preflight immediately when the start notice sees invalidation", async () => {
    const operation = createOperation();
    const initialEntry: SessionEntry = { sessionId: "queued-session", updatedAt: 1 };
    const replacementEntry: SessionEntry = { sessionId: "replacement-session", updatedAt: 2 };
    state.shouldNotifyCompaction = true;
    state.admitReply.mockResolvedValue({ status: "owned", operation, sessionEntry: initialEntry });
    state.loadEntry.mockReturnValueOnce(initialEntry).mockReturnValue(replacementEntry);
    state.preflight.mockImplementation(async ({ onCompactionNotice }) => {
      try {
        await onCompactionNotice?.("start");
      } catch {
        // The memory owner logs notice failures; the abort signal stops its compactor.
      }
      throw new Error("compaction aborted");
    });

    await expect(
      admitFollowupTurn({
        queued: createRun(),
        defaults: createDefaults({ sessionEntry: initialEntry, storePath: "/tmp/sessions.json" }),
      }),
    ).rejects.toThrow("Follow-up session generation changed");
    expect(operation.abortForRestart).toHaveBeenCalledOnce();
    expect(operation.complete).toHaveBeenCalledOnce();
  });

  it("returns a source-suppression-deliverable preflight failure", async () => {
    const operation = createOperation();
    state.admitReply.mockResolvedValue({ status: "owned", operation });
    state.preflight.mockRejectedValue(new Error("preflight failed"));

    const result = await admitFollowupTurn({
      queued: createRun(),
      defaults: createDefaults(),
    });

    expect(result).toMatchObject({
      kind: "admitted",
      turn: { preflightFailurePayload: { text: "preflight failed" } },
    });
    expect(operation.fail).toHaveBeenCalledWith("run_failed", expect.any(Error));
  });

  it("refreshes send policy before returning a preflight failure", async () => {
    const operation = createOperation();
    const initialEntry: SessionEntry = { sessionId: "queued-session", updatedAt: 1 };
    const sessionStore = { main: initialEntry };
    state.admitReply.mockResolvedValue({ status: "owned", operation, sessionEntry: initialEntry });
    state.preflight.mockImplementation(async () => {
      state.sendPolicy = "deny";
      throw new Error("preflight failed");
    });

    const result = await admitFollowupTurn({
      queued: createRun(),
      defaults: createDefaults({ sessionEntry: initialEntry, sessionStore }),
    });

    expect(result).toMatchObject({
      kind: "admitted",
      turn: { sendPolicy: "deny", preflightFailurePayload: { text: "preflight failed" } },
    });
  });

  it("restores the item when a failing preflight observes a replacement generation", async () => {
    const operation = createOperation();
    const initialEntry: SessionEntry = {
      sessionId: "queued-session",
      lifecycleRevision: "admitted",
      updatedAt: 1,
    };
    const replacementEntry: SessionEntry = {
      sessionId: "replacement-session",
      lifecycleRevision: "replacement",
      updatedAt: 2,
    };
    const sessionStore = { main: initialEntry };
    state.admitReply.mockResolvedValue({ status: "owned", operation, sessionEntry: initialEntry });
    state.preflight.mockImplementation(async () => {
      sessionStore.main = replacementEntry;
      throw new Error("preflight failed");
    });

    await expect(
      admitFollowupTurn({
        queued: createRun(),
        defaults: createDefaults({ sessionEntry: initialEntry, sessionStore }),
      }),
    ).rejects.toThrow("Follow-up session generation changed after reply admission");
    expect(operation.complete).toHaveBeenCalledOnce();
    expect(state.buildPreflightFailureText).not.toHaveBeenCalled();
  });

  it("restores the item when a failing preflight observes in-memory deletion", async () => {
    const operation = createOperation();
    const initialEntry: SessionEntry = {
      sessionId: "queued-session",
      lifecycleRevision: "admitted",
      updatedAt: 1,
    };
    const sessionStore: Record<string, SessionEntry> = { main: initialEntry };
    state.admitReply.mockResolvedValue({ status: "owned", operation, sessionEntry: initialEntry });
    state.preflight.mockImplementation(async () => {
      delete sessionStore.main;
      throw new Error("preflight failed");
    });

    await expect(
      admitFollowupTurn({
        queued: createRun(),
        defaults: createDefaults({ sessionEntry: initialEntry, sessionStore }),
      }),
    ).rejects.toThrow("Follow-up session generation changed");
    expect(operation.complete).toHaveBeenCalledOnce();
    expect(state.buildPreflightFailureText).not.toHaveBeenCalled();
  });

  it("uses admitted verbosity when formatting a preflight failure", async () => {
    const operation = createOperation();
    const admittedEntry: SessionEntry = {
      sessionId: "queued-session",
      updatedAt: 2,
      verboseLevel: "off",
    };
    state.admitReply.mockResolvedValue({ status: "owned", operation, sessionEntry: admittedEntry });
    state.loadEntry.mockReturnValue(admittedEntry);
    state.preflight.mockRejectedValue(new Error("preflight failed"));
    const queued = createRun();
    queued.run.verboseLevel = "full";

    await admitFollowupTurn({
      queued,
      defaults: createDefaults({ sessionEntry: admittedEntry }),
    });

    expect(state.buildPreflightFailureText).toHaveBeenCalledWith("preflight failed", {
      includeDetails: false,
    });
  });
});
