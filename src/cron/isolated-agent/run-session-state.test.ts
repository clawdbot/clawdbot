import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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
        sessionFile: missingTranscriptPath,
        label: "Cron: shell-only",
        status: "running",
      }),
    );
    const updateSessionStore = vi.fn(
      async (_storePath, update: (store: Record<string, SessionEntry>) => void) => {
        const store: Record<string, SessionEntry> = {};
        update(store);
        expect(store["agent:main:cron:shell-only"]).toEqual(
          expect.objectContaining({
            label: "Cron: shell-only",
            status: "running",
            updatedAt: 1000,
          }),
        );
        expect(store["agent:main:cron:shell-only"]?.sessionId).toBeUndefined();
        expect(store["agent:main:cron:shell-only"]?.sessionFile).toBeUndefined();
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
          expect(store["agent:main:cron:completed"]).toMatchObject({
            sessionId: "run-session-id",
            sessionFile: transcriptPath,
            label: "Cron: completed",
          });
        },
      ),
    });

    await persist();

    expect(cronSession.store["agent:main:cron:completed"]).toMatchObject({
      sessionId: "run-session-id",
      sessionFile: transcriptPath,
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
});

async function createTranscriptFile(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cron-session-"));
  const file = path.join(dir, "session.jsonl");
  await fs.writeFile(file, `${JSON.stringify({ type: "session", sessionId: "run-session-id" })}\n`);
  return file;
}
