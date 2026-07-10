// Run session state tests cover persisted session state for isolated cron agents.
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../../../test/helpers/temp-dir.js";
import type { SessionEntry } from "../../config/sessions.js";
import { beginSessionWorkAdmission } from "../../sessions/session-lifecycle-admission.js";
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

function makeCronSession(entry = makeSessionEntry()): MutableCronSession {
  return {
    storePath: "/tmp/sessions.json",
    store: {},
    sessionEntry: entry,
    systemSent: true,
    isNewSession: true,
    previousSessionId: undefined,
  } as MutableCronSession;
}

describe("createPersistCronSessionEntry", () => {
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
        }),
      ),
      lifecycleRevision,
    } as MutableCronSession;
    const store: Record<string, SessionEntry> = {};
    const updateSessionStore = vi.fn(
      async (_storePath, update: (entries: Record<string, SessionEntry>) => void) => update(store),
    );
    const continuation = createCronRunContinuationSession({
      isFastTestEnv: false,
      cronSession,
      runSessionKey,
      thinkingLevel: "high",
      toolsAllow: ["image_generate", "write"],
      toolsAllowIsDefault: true,
      updateSessionStore,
    });

    await continuation.initialize();
    expect(updateSessionStore).toHaveBeenCalledWith(cronSession.storePath, expect.any(Function), {
      activeSessionKey: runSessionKey,
      requireWriteSuccess: true,
    });
    expect(store[runSessionKey]).toMatchObject({
      sessionId: "run-session-id",
      modelProvider: "claude-cli",
      model: "claude-opus-4-8",
      thinkingLevel: "high",
      cronRunContinuation: {
        lifecycleRevision,
        phase: "running",
        toolsAllow: ["image_generate", "write"],
        toolsAllowIsDefault: true,
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
        sessionFile: await createTranscriptFile(),
        status: "running",
        startedAt: 900,
        skillsSnapshot: {
          prompt: "old prompt",
          skills: [{ name: "memory" }],
        },
      }),
    );
    const updateSessionStore = vi.fn(
      async (_storePath, update: (store: Record<string, SessionEntry>) => void) => {
        const store: Record<string, SessionEntry> = {};
        update(store);
        expect(store["agent:main:cron:job"]).toBe(cronSession.sessionEntry);
        expect(store["agent:main:cron:job:run:run-session-id"]).toBeUndefined();
      },
    );

    const persist = createPersistCronSessionEntry({
      isFastTestEnv: false,
      cronSession,
      agentSessionKey: "agent:main:cron:job",
      updateSessionStore,
    });

    await persist();

    expect(cronSession.store["agent:main:cron:job"]).toBe(cronSession.sessionEntry);
    expect(cronSession.store["agent:main:cron:job:run:run-session-id"]).toBeUndefined();
  });

  it("does not register cron sessions as resumable until the transcript exists", async () => {
    const missingTranscriptPath = path.join(
      os.tmpdir(),
      `openclaw-missing-cron-${crypto.randomUUID()}.jsonl`,
    );
    const cronSession = makeCronSession(
      makeSessionEntry({
        lifecycleRevision: "run-revision",
        sessionFile: missingTranscriptPath,
        label: "Cron: shell-only",
        status: "running",
      }),
    );
    const updateSessionStore = vi.fn(
      async (_storePath, update: (store: Record<string, SessionEntry>) => void) => {
        const store: Record<string, SessionEntry> = {};
        update(store);
        expect(store["agent:main:cron:shell-only"]).toEqual({
          label: "Cron: shell-only",
          lifecycleRevision: "run-revision",
          status: "running",
          updatedAt: 1000,
          systemSent: true,
        });
      },
    );

    const persist = createPersistCronSessionEntry({
      isFastTestEnv: false,
      cronSession,
      agentSessionKey: "agent:main:cron:shell-only",
      updateSessionStore,
    });

    await persist();

    expect(cronSession.store["agent:main:cron:shell-only"]?.sessionId).toBeUndefined();
    expect(cronSession.store["agent:main:cron:shell-only"]?.sessionFile).toBeUndefined();
    expect(cronSession.store["agent:main:cron:shell-only"]?.lifecycleRevision).toBe("run-revision");
    expect(cronSession.sessionEntry.sessionId).toBe("run-session-id");
    expect(cronSession.sessionEntry.sessionFile).toBe(missingTranscriptPath);
  });

  it("restores resumable cron fields once the transcript exists", async () => {
    const transcriptPath = await createTranscriptFile();
    const cronSession = makeCronSession(
      makeSessionEntry({
        sessionFile: transcriptPath,
        label: "Cron: completed",
      }),
    );

    const persist = createPersistCronSessionEntry({
      isFastTestEnv: false,
      cronSession,
      agentSessionKey: "agent:main:cron:completed",
      updateSessionStore: vi.fn(
        async (_storePath, update: (store: Record<string, SessionEntry>) => void) => {
          const store: Record<string, SessionEntry> = {};
          update(store);
          expect(store["agent:main:cron:completed"]).toEqual({
            sessionId: "run-session-id",
            sessionFile: transcriptPath,
            label: "Cron: completed",
            updatedAt: 1000,
            systemSent: true,
          });
        },
      ),
    });

    await persist();

    expect(cronSession.store["agent:main:cron:completed"]).toEqual({
      sessionId: "run-session-id",
      sessionFile: transcriptPath,
      label: "Cron: completed",
      updatedAt: 1000,
      systemSent: true,
    });
  });

  it("persists explicit session-bound cron state under the requested session key", async () => {
    const cronSession = makeCronSession();
    const updateSessionStore = vi.fn(
      async (_storePath, update: (store: Record<string, SessionEntry>) => void) => {
        const store: Record<string, SessionEntry> = {};
        update(store);
        expect(store["agent:main:session"]).toBe(cronSession.sessionEntry);
      },
    );

    const persist = createPersistCronSessionEntry({
      isFastTestEnv: false,
      cronSession,
      agentSessionKey: "agent:main:session",
      updateSessionStore,
    });

    await persist();

    expect(cronSession.store["agent:main:session"]).toBe(cronSession.sessionEntry);
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
    const updateSessionStore = vi.fn(
      async (_storePath, update: (store: Record<string, SessionEntry>) => void) => {
        update(persistedStore);
      },
    );
    const olderSession = makeConcurrentSession("older-revision");
    const newerSession = makeConcurrentSession("newer-revision");
    const persistOlder = createPersistCronSessionEntry({
      isFastTestEnv: false,
      cronSession: olderSession,
      agentSessionKey: sessionKey,
      updateSessionStore,
    });
    const persistNewer = createPersistCronSessionEntry({
      isFastTestEnv: false,
      cronSession: newerSession,
      agentSessionKey: sessionKey,
      updateSessionStore,
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
      isFastTestEnv: false,
      cronSession: nextSession,
      agentSessionKey: sessionKey,
      updateSessionStore: async (_storePath, update) => {
        update(persistedStore);
      },
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
      isFastTestEnv: false,
      cronSession,
      agentSessionKey: sessionKey,
      updateSessionStore: async (_storePath, update) => {
        update(persistedStore);
      },
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
      isFastTestEnv: false,
      cronSession,
      agentSessionKey: sessionKey,
      updateSessionStore: async (_storePath, update) => {
        update(persistedStore);
      },
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
      isFastTestEnv: false,
      cronSession,
      agentSessionKey: sessionKey,
      updateSessionStore: async (_storePath, update) => {
        update(persistedStore);
      },
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
        sessionFile: "/tmp/bound-session.jsonl",
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
    const updateSessionStore = vi.fn(
      async (_storePath, update: (store: Record<string, SessionEntry>) => void) => {
        const store: Record<string, SessionEntry> = {};
        update(store);
        expect(store["agent:main:telegram:direct:42"]).toEqual({
          sessionId: "bound-session-rotated",
          sessionFile: "/tmp/bound-session-rotated.jsonl",
          usageFamilyKey: "agent:main:telegram:direct:42",
          usageFamilySessionIds: ["bound-session", "bound-session-rotated"],
          updatedAt: 1000,
          systemSent: true,
        });
      },
    );

    expect(changed).toBe(true);
    const persist = createPersistCronSessionEntry({
      isFastTestEnv: false,
      cronSession,
      agentSessionKey: "agent:main:telegram:direct:42",
      updateSessionStore,
    });

    await persist();

    expect(cronSession.store["agent:main:telegram:direct:42"]).toEqual({
      sessionId: "bound-session-rotated",
      sessionFile: "/tmp/bound-session-rotated.jsonl",
      usageFamilyKey: "agent:main:telegram:direct:42",
      usageFamilySessionIds: ["bound-session", "bound-session-rotated"],
      updatedAt: 1000,
      systemSent: true,
    });
  });
});

const cronSessionTempDirs: string[] = [];

async function createTranscriptFile(): Promise<string> {
  const dir = makeTempDir(cronSessionTempDirs, "openclaw-cron-session-");
  const file = path.join(dir, "session.jsonl");
  await fs.writeFile(file, `${JSON.stringify({ type: "session", sessionId: "run-session-id" })}\n`);
  return file;
}

afterAll(() => {
  cleanupTempDirs(cronSessionTempDirs);
});
