import path from "node:path";
import { describe, expect, it } from "vitest";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  appendTranscriptEventSync,
  appendTranscriptMessageSync,
  ensureSessionEntrySync,
  loadSessionEntry,
  loadTranscriptEventsSync,
  replaceSessionEntrySync,
  replaceTranscriptEventsSync,
  type SessionTranscriptRuntimeTarget,
} from "./session-accessor.js";
import {
  getOwnedSessionTranscriptWriterFence,
  SessionTranscriptWriterClaimReboundError,
  withOwnedSessionTranscriptWrites,
  type OwnedSessionTranscriptWriteContext,
} from "./transcript-write-context.js";

async function withWriteTarget(run: (target: SessionTranscriptRuntimeTarget) => Promise<void>) {
  await withOpenClawTestState(
    { label: "owned-transcript-commit", scenario: "minimal" },
    async (state) => {
      await run({
        agentId: "main",
        sessionId: "owned-session",
        sessionKey: "agent:main:owned-transcript-commit",
        storePath: path.join(state.agentDir(), "openclaw-agent.sqlite"),
      });
    },
  );
}

const mutations = [
  {
    name: "header identity",
    write: (target: SessionTranscriptRuntimeTarget) =>
      ensureSessionEntrySync(target, { sessionId: target.sessionId, updatedAt: 2 }),
  },
  {
    name: "transcript replacement",
    write: (target: SessionTranscriptRuntimeTarget) => replaceTranscriptEventsSync(target, []),
  },
  {
    name: "event append",
    write: (target: SessionTranscriptRuntimeTarget) =>
      appendTranscriptEventSync(target, { type: "custom", id: "late-event" }),
  },
  {
    name: "message append",
    write: (target: SessionTranscriptRuntimeTarget) =>
      appendTranscriptMessageSync(target, { message: { role: "user", content: "late" } }),
  },
];

describe("owned transcript commit boundary", () => {
  it.each(mutations)(
    "rejects a revoked owner at $name without a scalar writer",
    async ({ write }) => {
      await withWriteTarget(async (target) => {
        const revoked = new Error("owner closed before commit");
        await withOwnedSessionTranscriptWrites(
          {
            sessionTarget: target,
            assertCommitAllowed: () => {
              throw revoked;
            },
            withTranscriptWrite: async (run) => await run(),
          },
          async () => {
            expect(() => write(target)).toThrow(revoked);
          },
        );
        expect(loadSessionEntry(target)).toBeUndefined();
        expect(loadTranscriptEventsSync(target)).toEqual([]);
      });
    },
  );

  it.each(mutations)("rejects a different physical target at $name", async ({ write }) => {
    await withWriteTarget(async (target) => {
      const other = { ...target, sessionId: "other-session" };
      replaceSessionEntrySync(other, { sessionId: other.sessionId, updatedAt: 1 });
      appendTranscriptEventSync(other, { type: "custom", id: "original" });
      const before = loadTranscriptEventsSync(other);
      await withOwnedSessionTranscriptWrites(
        {
          sessionTarget: target,
          assertCommitAllowed: () => {},
          withTranscriptWrite: async (run) => await run(),
        },
        async () => {
          expect(() => write(other)).toThrow(SessionTranscriptWriterClaimReboundError);
        },
      );
      expect(loadSessionEntry(other)?.updatedAt).toBe(1);
      expect(loadTranscriptEventsSync(other)).toEqual(before);
    });
  });

  it.each([false, true])(
    "checks owner after synchronous message preparation (revoke=%s)",
    async (revoke) => {
      await withWriteTarget(async (target) => {
        replaceSessionEntrySync(target, { sessionId: target.sessionId, updatedAt: 1 });
        const controller = new AbortController();
        const revoked = new Error("owner closed in message preparation");
        await withOwnedSessionTranscriptWrites(
          {
            sessionTarget: target,
            assertCommitAllowed: () => controller.signal.throwIfAborted(),
            withTranscriptWrite: async (run) => await run(),
          },
          async () => {
            const write = () =>
              appendTranscriptMessageSync(target, {
                message: { role: "user", content: "prepared" },
                prepareMessageAfterIdempotencyCheck: (message) => {
                  if (revoke) {
                    controller.abort(revoked);
                  }
                  return message;
                },
              });
            if (revoke) {
              expect(write).toThrow(revoked);
            } else {
              expect(write()).toMatchObject({ ok: true, value: { appended: true } });
            }
          },
        );
        expect(loadTranscriptEventsSync(target)).toHaveLength(revoke ? 0 : 2);
        expect(loadSessionEntry(target)?.sessionId).toBe(target.sessionId);
      });
    },
  );
});

const passthroughWrite = async <T>(run: () => Promise<T> | T) => await run();

const ownedRunContext = (sessionKey: string): OwnedSessionTranscriptWriteContext => ({
  sessionFile: `/tmp/sessions/${sessionKey}.jsonl`,
  sessionKey,
  sessionTarget: {
    agentId: "main",
    sessionId: `session-${sessionKey}`,
    sessionKey,
    storePath: "/tmp/agents/main/agent/openclaw-agent.sqlite",
    expectedLifecycleRevision: "rev-1",
    expectedWriterRunId: `run-${sessionKey}`,
  },
  withTranscriptWrite: passthroughWrite,
});

describe("owned transcript writer fence destination matching", () => {
  it("returns the admitted run claim for the owning session key", async () => {
    await withOwnedSessionTranscriptWrites(ownedRunContext("agent:main:discord:c:1"), async () => {
      expect(
        getOwnedSessionTranscriptWriterFence({ sessionKey: "agent:main:discord:c:1" }),
      ).toEqual({
        expectedLifecycleRevision: "rev-1",
        expectedWriterRunId: "run-agent:main:discord:c:1",
      });
    });
  });

  it("returns no claim for a different destination session key", async () => {
    await withOwnedSessionTranscriptWrites(ownedRunContext("agent:main:discord:c:1"), async () => {
      expect(
        getOwnedSessionTranscriptWriterFence({ sessionKey: "agent:main:discord:c:2" }),
      ).toBeUndefined();
    });
  });

  it("keeps matching the full store identity when the caller supplies a target", async () => {
    await withOwnedSessionTranscriptWrites(ownedRunContext("agent:main:discord:c:1"), async () => {
      expect(
        getOwnedSessionTranscriptWriterFence({
          sessionKey: "agent:main:discord:c:1",
          sessionTarget: {
            agentId: "main",
            sessionId: "session-agent:main:discord:c:1",
            sessionKey: "agent:main:discord:c:1",
            storePath: "/tmp/agents/main/agent/openclaw-agent.sqlite",
          },
        }),
      ).toEqual({
        expectedLifecycleRevision: "rev-1",
        expectedWriterRunId: "run-agent:main:discord:c:1",
      });
      expect(
        getOwnedSessionTranscriptWriterFence({
          sessionKey: "agent:main:discord:c:1",
          sessionTarget: {
            sessionKey: "agent:main:discord:c:1",
            storePath: "/tmp/agents/other/agent/openclaw-agent.sqlite",
          },
        }),
      ).toBeUndefined();
    });
  });
});
