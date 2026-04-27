import { describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../../config/sessions.js";
import { createPersistCronSessionEntry, type MutableCronSession } from "./run-session-state.js";

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
});
