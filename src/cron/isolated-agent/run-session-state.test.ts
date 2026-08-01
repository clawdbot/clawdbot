// Run session state tests cover persisted session state for isolated cron agents.
import crypto from "node:crypto";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../../../test/helpers/temp-dir.js";
import type { SessionEntry } from "../../config/sessions.js";
import { appendTranscriptMessage } from "../../config/sessions/session-accessor.js";
import { beginSessionWorkAdmission } from "../../sessions/session-lifecycle-admission.js";

const resetBoundaryMocks = vi.hoisted(() => ({
  clearBootstrap: vi.fn(),
}));

vi.mock("../../agents/bootstrap-cache.js", () => ({
  clearBootstrapSnapshotOnSessionBoundary: resetBoundaryMocks.clearBootstrap,
}));
import {
  adoptCronRunSessionMetadata,
  CronSessionLifecycleClaimError,
  createCronRunContinuationSession,
  createPersistCronSessionEntry,
  resolveCronLifecycleRevisionIdentity,
  type MutableCronSession,
} from "./run-session-state.js";

function makeSessionEntry(overrides?: Partial<SessionEntry>): SessionEntry {
  return {
    sessionId: "run-session-id",
    updatedAt: 1000,
    systemSent: true,
    ...overrides,
  };
}

function makeCronSession(
  entry = makeSessionEntry(),
  storePath = "/tmp/sessions.json",
): MutableCronSession {
  return {
    storePath,
    store: {},
    sessionEntry: entry,
    systemSent: true,
    isNewSession: true,
    previousSessionId: undefined,
  } as MutableCronSession;
}

/**
 * Guarded-persist seam backed by an in-memory persisted row, mirroring the
 * accessor contract: `update` sees the freshest persisted entry (undefined
 * when absent), may throw to reject a stale claim, and its return is committed.
 */
function makeGuardedPersistSessionEntry(persistedStore: Record<string, SessionEntry>) {
  return vi.fn(
    async (params: {
      fallbackEntry: SessionEntry;
      resetBoundaryReason?: "cron-stale";
      sessionKey: string;
      storePath: string;
      update: (currentEntry: SessionEntry | undefined) => SessionEntry;
    }) => {
      persistedStore[params.sessionKey] = params.update(persistedStore[params.sessionKey]);
    },
  );
}

describe("createPersistCronSessionEntry", () => {
  it("commits a pending reset boundary with the guarded session row", async () => {
    resetBoundaryMocks.clearBootstrap.mockClear();
    const lifecycleRevision = "00000000-0000-4000-8000-000000000001";
    const existingEntry = makeSessionEntry({ lifecycleRevision });
    const cronSession = {
      ...makeCronSession(existingEntry),
      initialSessionEntry: existingEntry,
      lifecycleRevision,
      resetBoundaryPending: {
        reason: "cron-stale" as const,
        sessionFile: "sqlite:main:run-session-id:/tmp/sessions.json",
      },
    } as MutableCronSession;
    const store: Record<string, SessionEntry> = {
      "agent:main:cron:job": existingEntry,
    };
    const persistSessionEntry = makeGuardedPersistSessionEntry(store);
    const persist = createPersistCronSessionEntry({
      cronSession,
      agentSessionKey: "agent:main:cron:job",
      persistSessionEntry,
    });

    await persist();

    expect(persistSessionEntry).toHaveBeenCalledWith(
      expect.objectContaining({ resetBoundaryReason: "cron-stale" }),
    );
    expect(resetBoundaryMocks.clearBootstrap).toHaveBeenCalledWith({
      boundaryAppended: true,
      sessionKey: "agent:main:cron:job",
    });
    expect(cronSession.resetBoundaryPending).toBeUndefined();
  });

  it("keeps a pending reset boundary when the guarded row commit fails", async () => {
    const cronSession = {
      ...makeCronSession(),
      resetBoundaryPending: {
        reason: "cron-stale" as const,
        sessionFile: "sqlite:main:run-session-id:/tmp/sessions.json",
      },
    } as MutableCronSession;
    const persist = createPersistCronSessionEntry({
      cronSession,
      agentSessionKey: "agent:main:cron:job",
      persistSessionEntry: vi.fn(async () => {
        throw new Error("write failed");
      }),
    });

    await expect(persist()).rejects.toThrow("write failed");

    expect(cronSession.resetBoundaryPending).toBeDefined();
  });

  it("owns an exact hidden continuation row without colliding with another run", async () => {
    const runSessionKey = "agent:main:cron:job:run:run-session-id";
    const lifecycleRevision = crypto.randomUUID();
    const replacementLifecycleRevision = crypto.randomUUID();
    const cronSession = {
      ...makeCronSession(
        makeSessionEntry({
          lifecycleRevision,
          modelProvider: "claude-cli",
          model: "claude-opus-4-8",
          // Node-local lineage on the base row must not leak onto the :run: node.
          previousSessionId: "base-prior-generation",
          forkSource: { sessionKey: "agent:main:other", sessionId: "other-generation" },
        }),
      ),
      lifecycleRevision,
    } as MutableCronSession;
    const store: Record<string, SessionEntry> = {};
    const persistSessionEntry = makeGuardedPersistSessionEntry(store);
    const continuation = createCronRunContinuationSession({
      cronSession,
      runSessionKey,
      thinkingLevel: "high",
      toolsAllow: ["image_generate", "write"],
      toolsAllowIsDefault: true,
      scheduledToolPolicy: {
        version: 1,
        mode: "account",
        ownerSessionKey: "agent:main:discord:group:ops",
        ownerAccountId: "work",
      },
      persistSessionEntry,
    });

    await continuation.initialize();
    expect(persistSessionEntry).toHaveBeenCalledWith({
      fallbackEntry: expect.objectContaining({ sessionId: "run-session-id" }),
      sessionKey: runSessionKey,
      storePath: cronSession.storePath,
      update: expect.any(Function),
    });
    expect(store[runSessionKey]?.previousSessionId).toBeUndefined();
    expect(store[runSessionKey]?.forkSource).toBeUndefined();
    expect(store[runSessionKey]).toMatchObject({
      createdVia: "cron",
      createdActor: { type: "system" },
      createdAt: expect.any(Number),
      sessionId: "run-session-id",
      modelProvider: "claude-cli",
      model: "claude-opus-4-8",
      thinkingLevel: "high",
      cronRunContinuation: {
        lifecycleRevision,
        phase: "running",
        toolsAllow: ["image_generate", "write"],
        toolsAllowIsDefault: true,
        scheduledToolPolicy: {
          version: 1,
          mode: "account",
          ownerSessionKey: "agent:main:discord:group:ops",
          ownerAccountId: "work",
        },
      },
    });

    await continuation.setCliExecutionProvider("claude-cli");
    expect(store[runSessionKey]?.cronRunContinuation?.cliExecutionProvider).toBe("claude-cli");

    cronSession.sessionEntry.cliSessionBindings = {
      "claude-cli": { sessionId: "native-claude-session", forceReuse: true },
    };
    await continuation.sync();
    expect(store[runSessionKey]?.cliSessionBindings?.["claude-cli"]).toEqual({
      sessionId: "native-claude-session",
      forceReuse: true,
    });

    await continuation.seal({ basePersisted: true });
    expect(store[runSessionKey]?.cronRunContinuation).toMatchObject({
      phase: "ready",
      basePersisted: true,
    });
    cronSession.sessionEntry.model = "newer-owner-model";
    await expect(continuation.sync()).rejects.toBeInstanceOf(CronSessionLifecycleClaimError);
    expect(store[runSessionKey]?.model).toBe("claude-opus-4-8");

    store[runSessionKey] = makeSessionEntry({
      sessionId: "continued-session-id",
      modelProvider: "anthropic",
      model: "claude-sonnet-4-6",
      cronRunContinuation: {
        lifecycleRevision,
        phase: "continuing",
        ownerRunId: "completion-run",
      },
    });
    await expect(continuation.sync()).rejects.toBeInstanceOf(CronSessionLifecycleClaimError);
    await expect(continuation.seal()).rejects.toBeInstanceOf(CronSessionLifecycleClaimError);
    expect(store[runSessionKey]).toMatchObject({
      sessionId: "continued-session-id",
      modelProvider: "anthropic",
      model: "claude-sonnet-4-6",
      cronRunContinuation: {
        lifecycleRevision,
        phase: "continuing",
        ownerRunId: "completion-run",
      },
    });

    store[runSessionKey] = makeSessionEntry({
      cronRunContinuation: { lifecycleRevision: replacementLifecycleRevision, phase: "ready" },
    });
    await expect(continuation.sync()).rejects.toBeInstanceOf(CronSessionLifecycleClaimError);
    expect(store[runSessionKey]?.cronRunContinuation?.lifecycleRevision).toBe(
      replacementLifecycleRevision,
    );
  });

  it("persists isolated cron state only under the stable cron session key", async () => {
    const cronSession = makeCronSession(
      makeSessionEntry({
        status: "running",
        startedAt: 900,
        skillsSnapshot: {
          prompt: "old prompt",
          skills: [{ name: "memory" }],
        },
      }),
    );
    const persistedStore: Record<string, SessionEntry> = {};
    const persistSessionEntry = makeGuardedPersistSessionEntry(persistedStore);

    const persist = createPersistCronSessionEntry({
      cronSession,
      agentSessionKey: "agent:main:cron:job",
      persistSessionEntry,
    });

    await persist();

    expect(cronSession.store["agent:main:cron:job"]).toMatchObject({
      createdVia: "cron",
      createdActor: { type: "system" },
      createdAt: expect.any(Number),
    });
    expect(persistedStore["agent:main:cron:job"]).toMatchObject({
      createdVia: "cron",
      createdActor: { type: "system" },
      createdAt: expect.any(Number),
    });
    expect(cronSession.store["agent:main:cron:job:run:run-session-id"]).toBeUndefined();
    expect(persistSessionEntry).toHaveBeenCalledWith({
      storePath: "/tmp/sessions.json",
      sessionKey: "agent:main:cron:job",
      fallbackEntry: expect.objectContaining({ sessionId: "run-session-id" }),
      update: expect.any(Function),
    });
  });

  it("does not register cron sessions as resumable until the transcript exists", async () => {
    const cronSession = makeCronSession(
      makeSessionEntry({
        lifecycleRevision: "run-revision",
        label: "Cron: shell-only",
        status: "running",
      }),
    );
    const persistSessionEntry = vi.fn(async () => {});

    const persist = createPersistCronSessionEntry({
      cronSession,
      agentSessionKey: "agent:main:cron:shell-only",
      persistSessionEntry,
    });

    await persist();

    expect(cronSession.store["agent:main:cron:shell-only"]?.sessionId).toBe("run-session-id");
    expect(cronSession.store["agent:main:cron:shell-only"]?.sessionFile).toBeUndefined();
    expect(cronSession.store["agent:main:cron:shell-only"]?.lifecycleRevision).toBe("run-revision");
    expect(cronSession.sessionEntry.sessionId).toBe("run-session-id");
    expect(persistSessionEntry).toHaveBeenCalledWith({
      storePath: "/tmp/sessions.json",
      sessionKey: "agent:main:cron:shell-only",
      fallbackEntry: {
        label: "Cron: shell-only",
        lifecycleRevision: "run-revision",
        sessionId: "run-session-id",
        status: "running",
        updatedAt: 1000,
        systemSent: true,
      },
      update: expect.any(Function),
    });
  });

  it("restores resumable cron fields once the transcript exists", async () => {
    const dir = makeTempDir(cronSessionTempDirs, "openclaw-cron-session-");
    const storePath = path.join(dir, "sessions.json");
    await appendTranscriptMessage(
      {
        agentId: "main",
        sessionId: "run-session-id",
        sessionKey: "agent:main:cron:completed",
        storePath,
      },
      { message: { role: "user", content: "cron prompt" } },
    );
    const cronSession = makeCronSession(
      makeSessionEntry({
        label: "Cron: completed",
      }),
      storePath,
    );

    const persist = createPersistCronSessionEntry({
      cronSession,
      agentSessionKey: "agent:main:cron:completed",
      persistSessionEntry: vi.fn(async () => {}),
    });

    await persist();

    expect(cronSession.store["agent:main:cron:completed"]).toEqual({
      sessionId: "run-session-id",
      label: "Cron: completed",
      updatedAt: 1000,
      systemSent: true,
    });
  });

  it("persists explicit session-bound cron state under the requested session key", async () => {
    const cronSession = makeCronSession();
    const persistSessionEntry = vi.fn(async () => {});

    const persist = createPersistCronSessionEntry({
      cronSession,
      agentSessionKey: "agent:main:session",
      persistSessionEntry,
    });

    await persist();

    expect(cronSession.store["agent:main:session"]).toBe(cronSession.sessionEntry);
    expect(persistSessionEntry).toHaveBeenCalledWith({
      storePath: "/tmp/sessions.json",
      sessionKey: "agent:main:session",
      fallbackEntry: cronSession.sessionEntry,
      update: expect.any(Function),
    });
  });

  it("does not let an older concurrent run reclaim a persisted lifecycle revision", async () => {
    const sessionKey = "agent:main:session";
    const initialSessionEntry = makeSessionEntry({ lifecycleRevision: "initial-revision" });
    const persistedStore: Record<string, SessionEntry> = {
      [sessionKey]: initialSessionEntry,
    };
    const makeConcurrentSession = (lifecycleRevision: string): MutableCronSession =>
      ({
        ...makeCronSession(
          makeSessionEntry({
            lifecycleRevision,
            label: lifecycleRevision,
          }),
        ),
        initialSessionEntry,
        lifecycleRevision,
      }) as MutableCronSession;
    const persistSessionEntry = makeGuardedPersistSessionEntry(persistedStore);
    const olderSession = makeConcurrentSession("older-revision");
    const newerSession = makeConcurrentSession("newer-revision");
    const persistOlder = createPersistCronSessionEntry({
      cronSession: olderSession,
      agentSessionKey: sessionKey,
      persistSessionEntry,
    });
    const persistNewer = createPersistCronSessionEntry({
      cronSession: newerSession,
      agentSessionKey: sessionKey,
      persistSessionEntry,
    });

    await persistNewer();
    await expect(persistOlder()).rejects.toThrow(
      `Session "${sessionKey}" changed while starting work. Retry.`,
    );

    expect(persistedStore[sessionKey]).toStrictEqual(newerSession.sessionEntry);
    expect(olderSession.store[sessionKey]).toBeUndefined();
  });

  it("does not replace a lifecycle revision while its owner is admitted", async () => {
    const sessionKey = "agent:main:session";
    const storePath = "/tmp/sessions-active-lifecycle.json";
    const activeRevision = crypto.randomUUID();
    const nextRevision = crypto.randomUUID();
    const activeEntry = makeSessionEntry({ lifecycleRevision: activeRevision });
    const persistedStore: Record<string, SessionEntry> = { [sessionKey]: activeEntry };
    const nextSession = {
      ...makeCronSession(makeSessionEntry({ lifecycleRevision: nextRevision })),
      initialSessionEntry: activeEntry,
      lifecycleRevision: nextRevision,
      storePath,
    } as MutableCronSession;
    const persistNext = createPersistCronSessionEntry({
      cronSession: nextSession,
      agentSessionKey: sessionKey,
      persistSessionEntry: makeGuardedPersistSessionEntry(persistedStore),
    });
    const activeLease = await beginSessionWorkAdmission({
      scope: storePath,
      identities: [resolveCronLifecycleRevisionIdentity(activeRevision)],
      assertAllowed: () => {},
    });

    try {
      await expect(persistNext()).rejects.toThrow(
        `Session "${sessionKey}" changed while starting work. Retry.`,
      );
      expect(persistedStore[sessionKey]).toBe(activeEntry);
    } finally {
      activeLease.release();
    }
    await expect(persistNext()).resolves.toBeUndefined();
    expect(persistedStore[sessionKey]).toStrictEqual(nextSession.sessionEntry);
  });

  it("claims an initial row after a benign concurrent same-generation field write", async () => {
    // Repro for the session-store claim race: under a large, busy store a
    // concurrent writer advances an ownership field (delivery/token/status) on
    // the row WITHOUT minting a new lifecycle generation, between resolve and
    // this run's first persist. The row still carries the run's resolved
    // lifecycle revision, so no competing run has claimed it. The guard must
    // merge-and-claim, not throw CronSessionLifecycleClaimError.
    const sessionKey = "agent:main:session";
    const initialRevision = "initial-revision";
    const runRevision = crypto.randomUUID();
    const initialSessionEntry = makeSessionEntry({
      lifecycleRevision: initialRevision,
      status: "running",
      totalTokens: 10,
    });
    const cronSession = {
      ...makeCronSession(
        makeSessionEntry({
          lifecycleRevision: runRevision,
          status: "done",
          totalTokens: 42,
        }),
      ),
      initialSessionEntry,
      lifecycleRevision: runRevision,
    } as MutableCronSession;
    const persistedStore: Record<string, SessionEntry> = {
      [sessionKey]: {
        ...initialSessionEntry,
        // Concurrent benign update: same lifecycle generation, drifted fields.
        totalTokens: 25,
        lastInteractionAt: 2000,
        updatedAt: 2000,
      },
    };
    const persist = createPersistCronSessionEntry({
      cronSession,
      agentSessionKey: sessionKey,
      persistSessionEntry: makeGuardedPersistSessionEntry(persistedStore),
    });

    await expect(persist()).resolves.toBeUndefined();

    // The run claims (its revision wins) while the concurrent update survives.
    expect(persistedStore[sessionKey]).toMatchObject({
      lifecycleRevision: runRevision,
      status: "done",
      totalTokens: 25,
      lastInteractionAt: 2000,
    });
  });

  it("does not claim the same lifecycle revision after the session id rotates", async () => {
    const sessionKey = "agent:main:session";
    const initialRevision = "initial-revision";
    const runRevision = crypto.randomUUID();
    const initialSessionEntry = makeSessionEntry({
      sessionId: "initial-session-id",
      lifecycleRevision: initialRevision,
    });
    const cronSession = {
      ...makeCronSession(
        makeSessionEntry({
          sessionId: "initial-session-id",
          lifecycleRevision: runRevision,
        }),
      ),
      initialSessionEntry,
      lifecycleRevision: runRevision,
    } as MutableCronSession;
    const rotatedEntry = makeSessionEntry({
      sessionId: "rotated-session-id",
      lifecycleRevision: initialRevision,
      updatedAt: 2000,
    });
    const persistedStore: Record<string, SessionEntry> = {
      [sessionKey]: rotatedEntry,
    };
    const persist = createPersistCronSessionEntry({
      cronSession,
      agentSessionKey: sessionKey,
      persistSessionEntry: makeGuardedPersistSessionEntry(persistedStore),
    });

    await expect(persist()).rejects.toBeInstanceOf(CronSessionLifecycleClaimError);

    expect(persistedStore[sessionKey]).toBe(rotatedEntry);
    expect(cronSession.store[sessionKey]).toBeUndefined();
    expect(cronSession.sessionEntry.sessionId).toBe("initial-session-id");
  });

  it("claims an initial row after a concurrent pin and rename", async () => {
    const sessionKey = "agent:main:session";
    const lifecycleRevision = crypto.randomUUID();
    const initialSessionEntry = makeSessionEntry({ lifecycleRevision: "initial-revision" });
    const cronSession = {
      ...makeCronSession(
        makeSessionEntry({
          lifecycleRevision,
          status: "running",
        }),
      ),
      initialSessionEntry,
      lifecycleRevision,
    } as MutableCronSession;
    const persistedStore: Record<string, SessionEntry> = {
      [sessionKey]: {
        ...initialSessionEntry,
        label: "Renamed before claim",
        pinnedAt: 2000,
        updatedAt: 2000,
      },
    };
    const persist = createPersistCronSessionEntry({
      cronSession,
      agentSessionKey: sessionKey,
      persistSessionEntry: makeGuardedPersistSessionEntry(persistedStore),
    });

    await expect(persist()).resolves.toBeUndefined();
    expect(persistedStore[sessionKey]).toMatchObject({
      label: "Renamed before claim",
      lifecycleRevision,
      pinnedAt: 2000,
      status: "running",
      updatedAt: 2000,
    });
  });

  it.each([
    {
      name: "pin and rename",
      current: { label: "Renamed", pinnedAt: 2000, updatedAt: 2000 },
      expected: { label: "Renamed", pinnedAt: 2000, updatedAt: 2000 },
    },
    {
      name: "unpin and clear the label",
      current: { label: undefined, pinnedAt: undefined, updatedAt: 2000 },
      expected: { label: undefined, pinnedAt: undefined, updatedAt: 2000 },
    },
  ])("preserves a concurrent $name during cron persistence", async ({ current, expected }) => {
    const sessionKey = "agent:main:session";
    const lifecycleRevision = crypto.randomUUID();
    const runEntry = makeSessionEntry({
      lifecycleRevision,
      label: "Original",
      pinnedAt: 1000,
      status: "done",
    });
    const cronSession = {
      ...makeCronSession(runEntry),
      initialSessionEntry: { ...runEntry },
      lifecycleRevision,
    } as MutableCronSession;
    const persistedStore: Record<string, SessionEntry> = {
      [sessionKey]: {
        ...cronSession.sessionEntry,
        ...current,
      },
    };
    const persist = createPersistCronSessionEntry({
      cronSession,
      agentSessionKey: sessionKey,
      persistSessionEntry: makeGuardedPersistSessionEntry(persistedStore),
    });

    await persist();

    expect(persistedStore[sessionKey]).toMatchObject({
      lifecycleRevision,
      status: "done",
      updatedAt: expected.updatedAt,
    });
    expect(persistedStore[sessionKey]?.label).toBe(expected.label);
    expect(persistedStore[sessionKey]?.pinnedAt).toBe(expected.pinnedAt);
    expect(cronSession.sessionEntry.label).toBe(expected.label);
    expect(cronSession.sessionEntry.pinnedAt).toBe(expected.pinnedAt);
    expect(cronSession.sessionEntry.updatedAt).toBe(expected.updatedAt);
  });

  it("does not restore session policy cleared while a cron run is active", async () => {
    const sessionKey = "agent:main:session";
    const lifecycleRevision = crypto.randomUUID();
    const initialSessionEntry = makeSessionEntry({
      lifecycleRevision,
      chatType: "direct",
      elevatedLevel: "full",
      inheritedToolAllow: ["exec"],
      sendPolicy: "allow",
    });
    const cronSession = {
      ...makeCronSession({
        ...initialSessionEntry,
        status: "done",
        totalTokens: 42,
      }),
      initialSessionEntry,
      lifecycleRevision,
    } as MutableCronSession;
    const currentEntry: SessionEntry = {
      ...initialSessionEntry,
      chatType: "group",
      sendPolicy: "deny",
      updatedAt: 2000,
    };
    delete currentEntry.elevatedLevel;
    delete currentEntry.inheritedToolAllow;
    const persistedStore: Record<string, SessionEntry> = { [sessionKey]: currentEntry };
    const persist = createPersistCronSessionEntry({
      cronSession,
      agentSessionKey: sessionKey,
      persistSessionEntry: makeGuardedPersistSessionEntry(persistedStore),
    });

    await persist();

    expect(persistedStore[sessionKey]).toMatchObject({
      chatType: "group",
      sendPolicy: "deny",
      status: "done",
      totalTokens: 42,
      updatedAt: 2000,
    });
    expect(persistedStore[sessionKey]?.elevatedLevel).toBeUndefined();
    expect(persistedStore[sessionKey]?.inheritedToolAllow).toBeUndefined();
  });

  it("adopts rotated run transcript metadata before persisting session-bound cron state", async () => {
    const cronSession = makeCronSession(
      makeSessionEntry({
        sessionId: "bound-session",
      }),
    );
    const changed = adoptCronRunSessionMetadata({
      entry: cronSession.sessionEntry,
      sessionKey: "agent:main:telegram:direct:42",
      runMeta: {
        sessionId: "bound-session-rotated",
        sessionFile: "/tmp/bound-session-rotated.jsonl",
      },
    });
    const persistSessionEntry = vi.fn(async () => {});

    expect(changed).toBe(true);
    const persist = createPersistCronSessionEntry({
      cronSession,
      agentSessionKey: "agent:main:telegram:direct:42",
      persistSessionEntry,
    });

    await persist();

    expect(cronSession.store["agent:main:telegram:direct:42"]).toEqual({
      sessionId: "bound-session-rotated",
      usageFamilyKey: "agent:main:telegram:direct:42",
      usageFamilySessionIds: ["bound-session", "bound-session-rotated"],
      updatedAt: 1000,
      systemSent: true,
    });
    expect(persistSessionEntry).toHaveBeenCalledWith({
      storePath: "/tmp/sessions.json",
      sessionKey: "agent:main:telegram:direct:42",
      fallbackEntry: {
        sessionId: "bound-session-rotated",
        usageFamilyKey: "agent:main:telegram:direct:42",
        usageFamilySessionIds: ["bound-session", "bound-session-rotated"],
        updatedAt: 1000,
        systemSent: true,
      },
      update: expect.any(Function),
    });
  });
});

const cronSessionTempDirs: string[] = [];

afterAll(() => {
  cleanupTempDirs(cronSessionTempDirs);
});
