import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ContextEngineRuntimeContext } from "../../context-engine/types.js";
import {
  type RecoveryFixture,
  waitForCompactionAbort,
  withRecoveryFixture,
} from "./run.compaction-runtime.test-support.js";

// These counters observe recovery continuation only, not another model request:
// downstream dispatch already has its own authority and cancellation guards.
describe("embedded compaction recovery authority", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(["overflow", "timeout"] as const)(
    "accepts a healthy declared successor through the host writer (%s)",
    async (kind) => {
      await withRecoveryFixture({ oversized: false }, async (fixture) => {
        const before = fixture.loadEntry();
        expect(before).toHaveProperty("activeWriterRunId", fixture.runId);
        const successorId = randomUUID();
        fixture.compact.mockImplementationOnce(async ({ sessionTarget }) => {
          // Engines declare the public successor; only the host may transfer
          // the real durable row and retain its private admitted-writer facts.
          expect(sessionTarget).not.toHaveProperty("expectedWriterRunId");
          expect(fixture.loadEntry()?.sessionId).toBe(before?.sessionId);
          return {
            ok: true,
            compacted: true,
            result: {
              summary: "Engine-owned successor context",
              tokensBefore: 4_097,
              tokensAfter: 3_000,
              sessionId: successorId,
              sessionTarget: { ...sessionTarget, sessionId: successorId, threadId: "thread-hint" },
            },
          };
        });

        await expect(fixture.recover(kind)).resolves.toEqual(
          kind === "overflow" ? { action: "retry" } : true,
        );

        const after = fixture.loadEntry();
        expect(after?.sessionId).toBe(successorId);
        expect(after?.lifecycleRevision).toBe(before?.lifecycleRevision);
        expect(after).toHaveProperty("activeWriterRunId", fixture.runId);
        expect(fixture.getSessionTarget()).toMatchObject({
          sessionId: successorId,
          threadId: "thread-hint",
        });
        expect(fixture.getCommittedSuccessor()?.entry).toEqual(after);
        expect(fixture.recoveryState).toMatchObject({
          autoCompactionCount: 1,
          lastCompactionTokensAfter: 3_000,
        });
        expect(fixture.afterHook).toHaveBeenCalledWith(
          expect.objectContaining({ previousSessionId: before?.sessionId }),
          expect.objectContaining({ sessionId: successorId }),
        );
        fixture.assertActive();
      });
    },
  );

  it.each(["overflow", "timeout"] as const)(
    "records successor target and tokens before an identity observer aborts %s recovery",
    async (kind) => {
      await withRecoveryFixture({ oversized: false }, async (fixture) => {
        const { onSessionIdentityMutation } =
          await import("../../sessions/session-lifecycle-events.js");
        const previousSessionId = fixture.loadEntry()?.sessionId;
        const successorId = randomUUID();
        let atObserver:
          | {
              accepted: ReturnType<RecoveryFixture["getCommittedSuccessor"]>;
              count: number;
              tokensAfter: number | undefined;
            }
          | undefined;
        const unsubscribe = onSessionIdentityMutation((mutation) => {
          if (mutation.kind !== "replace" || mutation.previous.sessionId !== previousSessionId) {
            return;
          }
          atObserver = {
            accepted: fixture.getCommittedSuccessor(),
            count: fixture.recoveryState.autoCompactionCount,
            tokensAfter: fixture.recoveryState.lastCompactionTokensAfter,
          };
          fixture.updates.mockClear();
          fixture.stop();
        });
        fixture.compact.mockResolvedValueOnce({
          ok: true,
          compacted: true,
          result: {
            summary: "successor context",
            tokensBefore: 4_097,
            tokensAfter: 3_000,
            sessionId: successorId,
          },
        });
        try {
          await expect(fixture.recover(kind)).rejects.toBe(fixture.callerError);
          expect(atObserver).toMatchObject({
            accepted: {
              sessionId: successorId,
              previousSessionId,
              entry: { sessionId: successorId, activeWriterRunId: fixture.runId },
            },
            count: 1,
            tokensAfter: 3_000,
          });
          expect(fixture.getCommittedSuccessor()).toBe(atObserver?.accepted);
          expect(fixture.loadEntry()?.sessionId).toBe(successorId);
          expect(fixture.maintain).not.toHaveBeenCalled();
          expect(fixture.afterHook).not.toHaveBeenCalled();
          expect(fixture.updates).not.toHaveBeenCalled();
          fixture.expectNoContinuation();
        } finally {
          unsubscribe();
        }
      });
    },
  );

  it.each(["overflow", "timeout"] as const)(
    "keeps %s recovery read-only when detached without a caller-owned manager",
    async (kind) => {
      await withRecoveryFixture({ detached: true, oversized: false }, async (fixture) => {
        const before = await fixture.snapshot();
        const entryBefore = fixture.loadEntry();
        let rewriteError: unknown;
        fixture.compact.mockResolvedValueOnce({
          ok: true,
          compacted: true,
          result: { summary: "engine-owned context", tokensBefore: 4_097, tokensAfter: 3_000 },
        });
        fixture.maintain.mockImplementationOnce(async ({ runtimeContext }) => {
          try {
            await runtimeContext?.rewriteTranscriptEntries?.({
              replacements: [fixture.replacement],
            });
          } catch (error) {
            rewriteError = error;
          }
          return { changed: false, rewrittenEntries: 0, bytesFreed: 0 };
        });
        fixture.updates.mockClear();

        await expect(fixture.recover(kind)).resolves.toEqual(
          kind === "overflow" ? { action: "retry" } : true,
        );

        expect(await fixture.snapshot()).toEqual(before);
        expect(fixture.loadEntry()).toEqual(entryBefore);
        expect(fixture.getCommittedSuccessor()).toBeUndefined();
        expect(fixture.recoveryState).toMatchObject({
          autoCompactionCount: 1,
          lastCompactionTokensAfter: 3_000,
        });
        expect(fixture.updates).not.toHaveBeenCalled();
        if (kind === "overflow") {
          expect(rewriteError).toBeInstanceOf(Error);
          expect(String(rewriteError)).toContain(
            "detached recovery has no caller-owned transcript",
          );
        }
        fixture.assertActive();
      });
    },
  );

  it.each(["overflow", "timeout"] as const)(
    "blocks an ordinary portable SessionManager write inside detached %s compaction",
    async (kind) => {
      await withRecoveryFixture({ detached: true, oversized: false }, async (fixture) => {
        const before = await fixture.snapshot();
        const entryBefore = fixture.loadEntry();
        fixture.updates.mockClear();

        // Unlike the engine-owned detached control above, the fixture's default backend
        // opens a real SessionManager with its portable target and no writer claim.
        const outcome = await fixture.recover(kind);

        expect(fixture.compact).toHaveBeenCalledOnce();
        await expect.soft(fixture.compact.mock.results[0]?.value).rejects.toBeInstanceOf(Error);
        if (kind === "overflow") {
          expect.soft(outcome).toMatchObject({ action: "surface", kind: "context_overflow" });
        } else {
          expect.soft(outcome).toBe(false);
        }
        expect.soft(await fixture.snapshot()).toEqual(before);
        expect.soft(fixture.loadEntry()).toEqual(entryBefore);
        expect.soft(fixture.recoveryState.autoCompactionCount).toBe(0);
        expect.soft(fixture.recoveryState.lastCompactionTokensAfter).toBeUndefined();
        expect(fixture.maintain).not.toHaveBeenCalled();
        expect(fixture.afterHook).not.toHaveBeenCalled();
        expect(fixture.updates).not.toHaveBeenCalled();
        fixture.expectNoContinuation();
      });
    },
  );

  it.each([
    { kind: "overflow", oversized: false },
    { kind: "overflow", oversized: true },
    { kind: "timeout", oversized: true },
  ] as const)(
    "preserves the exact caller error without post-abort work ($kind, oversized=$oversized)",
    async ({ kind, oversized }) => {
      await withRecoveryFixture({ oversized }, async (fixture) => {
        const before = await fixture.snapshot();
        fixture.updates.mockClear();
        fixture.compact.mockImplementationOnce(({ abortSignal }) =>
          waitForCompactionAbort(abortSignal, () => queueMicrotask(fixture.stop)),
        );

        const outcome = await fixture.recover(kind).then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        );

        expect.soft(outcome).toEqual({ error: fixture.callerError });
        if ("error" in outcome) {
          expect.soft(outcome.error).toBe(fixture.callerError);
        }
        expect.soft(await fixture.snapshot()).toEqual(before);
        expect(fixture.compact).toHaveBeenCalledOnce();
        expect(fixture.beforeHook).toHaveBeenCalledOnce();
        expect(fixture.maintain).not.toHaveBeenCalled();
        expect(fixture.afterHook).not.toHaveBeenCalled();
        expect(fixture.updates).not.toHaveBeenCalled();
        expect(fixture.recoveryState.autoCompactionCount).toBe(0);
        fixture.expectNoContinuation();
      });
    },
  );

  it.each(
    (["overflow", "timeout"] as const).flatMap((kind) =>
      (["closed", "replaced", "writer-replaced"] as const).map((loss) => ({ kind, loss })),
    ),
  )(
    "stops $kind recovery when authority is $loss without a caller signal",
    async ({ kind, loss }) => {
      await withRecoveryFixture({}, async (fixture) => {
        const before = await fixture.snapshot();
        fixture.updates.mockClear();
        fixture.compact.mockImplementationOnce(async () => {
          await fixture.invalidate(loss);
          throw new Error("engine failed after losing its owner");
        });

        await expect.soft(fixture.recover(kind)).rejects.toBeInstanceOf(Error);

        expect.soft(await fixture.snapshot()).toEqual(before);
        expect(fixture.afterHook).not.toHaveBeenCalled();
        expect(fixture.updates).not.toHaveBeenCalled();
        fixture.expectNoContinuation();
      });
    },
  );

  it("retains and counts a committed compaction once when the caller stops during maintenance", async () => {
    await withRecoveryFixture({}, async (fixture) => {
      const before = await fixture.snapshot();
      let committed: Awaited<ReturnType<RecoveryFixture["snapshot"]>> | undefined;
      fixture.maintain.mockImplementationOnce(async () => {
        committed = await fixture.snapshot();
        fixture.updates.mockClear();
        fixture.stop();
        return { changed: false, rewrittenEntries: 0, bytesFreed: 0 };
      });

      await expect.soft(fixture.recover("overflow", true)).rejects.toBe(fixture.callerError);

      expect(committed?.eventDigests).toHaveLength(before.eventDigests.length + 1);
      expect(committed?.eventDigests.slice(0, before.eventDigests.length)).toEqual(
        before.eventDigests,
      );
      expect(committed?.compactionIds).toHaveLength(1);
      expect.soft(await fixture.snapshot()).toEqual(committed);
      expect(fixture.recoveryState).toMatchObject({
        autoCompactionCount: 1,
        lastCompactionTokensAfter: 3_000,
      });
      expect(fixture.afterHook).not.toHaveBeenCalled();
      expect(fixture.updates).not.toHaveBeenCalled();
      fixture.expectNoContinuation();
    });
  });

  it("retains timeout compaction accounting but stops publication and retry after an after-hook abort", async () => {
    await withRecoveryFixture({}, async (fixture) => {
      fixture.afterHook.mockImplementationOnce(async () => {
        fixture.updates.mockClear();
        fixture.stop();
      });

      await expect.soft(fixture.recover("timeout")).rejects.toBe(fixture.callerError);

      expect((await fixture.snapshot()).compactionIds).toHaveLength(1);
      expect(fixture.recoveryState).toMatchObject({
        autoCompactionCount: 1,
        lastCompactionTokensAfter: 3_000,
      });
      expect(fixture.afterHook).toHaveBeenCalledOnce();
      expect(fixture.updates).not.toHaveBeenCalled();
      fixture.expectNoContinuation();
    });
  });

  it.each(["engine failure", "safety timeout"] as const)(
    "still truncates overflow after an independent %s while the caller is active",
    async (failure) => {
      await withRecoveryFixture({}, async (fixture) => {
        const before = await fixture.snapshot();
        fixture.updates.mockClear();
        fixture.compact.mockImplementationOnce(async ({ abortSignal }) => {
          if (failure === "engine failure") {
            throw new Error("independent engine failure");
          }
          return await waitForCompactionAbort(abortSignal);
        });

        await expect(fixture.recover("overflow")).resolves.toEqual({ action: "retry" });

        fixture.assertActive();
        expect(fixture.controller.signal.aborted).toBe(false);
        const after = await fixture.snapshot();
        expect(after.eventDigests.slice(0, before.eventDigests.length)).toEqual(
          before.eventDigests,
        );
        expect(after.eventDigests.length).toBeGreaterThan(before.eventDigests.length);
        expect(after.leafId).not.toBe(before.leafId);
        expect(after.toolResultChars).toBeGreaterThan(0);
        expect(after.toolResultChars).toBeLessThan(before.toolResultChars);
        expect(fixture.updates).toHaveBeenCalled();
        expect(fixture.recoveryState.autoCompactionCount).toBe(0);
      });
    },
  );

  it.each([
    { kind: "overflow", failure: "throw" },
    { kind: "timeout", failure: "safety timeout" },
  ] as const)(
    "retries $kind from committed context after an active backend $failure",
    async ({ kind, failure }) => {
      const { readCompactionAccountingRecorder } =
        await import("./run/compaction-accounting-bridge.js");
      const compactionHooks = await import("./compaction-hooks.js");
      const postEffects = vi.spyOn(compactionHooks, "runPostCompactionSideEffects");
      await withRecoveryFixture({ oversized: true }, async (fixture) => {
        const before = await fixture.snapshot();
        const entryBefore = fixture.loadEntry();
        const targetBefore = fixture.getSessionTarget();
        const sourceError = new Error("backend failed after committing compaction");
        const originalCompact = fixture.compact.getMockImplementation();
        if (!originalCompact) {
          throw new Error("Fixture must provide the real append implementation");
        }
        let childSignal: AbortSignal | undefined;
        fixture.compact.mockImplementationOnce(async (params) => {
          const committed = await originalCompact(params);
          const recorder = readCompactionAccountingRecorder(params.runtimeContext);
          if (!recorder) {
            throw new Error("Recovery must attach its private accounting recorder");
          }
          recorder.recordCompaction(committed.result?.tokensAfter);
          fixture.updates.mockClear();
          childSignal = params.abortSignal;
          if (failure === "throw") {
            throw sourceError;
          }
          return await waitForCompactionAbort(childSignal);
        });

        const outcome = await fixture.recover(kind);

        fixture.assertActive();
        expect(fixture.controller.signal.aborted).toBe(false);
        expect(fixture.compact).toHaveBeenCalledOnce();
        if (failure === "throw") {
          await expect(fixture.compact.mock.results[0]?.value).rejects.toBe(sourceError);
        } else {
          expect(childSignal?.aborted).toBe(true);
          await expect(fixture.compact.mock.results[0]?.value).rejects.toBe(childSignal?.reason);
        }
        expect.soft(outcome).toEqual(kind === "overflow" ? { action: "retry" } : true);
        const after = await fixture.snapshot();
        expect.soft(after.eventDigests).toHaveLength(before.eventDigests.length + 1);
        expect(after.eventDigests.slice(0, before.eventDigests.length)).toEqual(
          before.eventDigests,
        );
        expect(after.compactionIds).toHaveLength(1);
        expect.soft(after.leafId).toBe(after.compactionIds[0]);
        expect.soft(after.toolResultChars).toBe(before.toolResultChars);
        expect(fixture.loadEntry()).toEqual(entryBefore);
        expect(fixture.getSessionTarget()).toEqual(targetBefore);
        expect(fixture.recoveryState).toMatchObject({
          autoCompactionCount: 1,
          lastCompactionTokensAfter: 3_000,
          currentContextSnapshot: { tokens: 3_000 },
        });
        expect.soft(fixture.recoveryState.toolResultTruncationAttempted).toBe(false);
        expect(fixture.maintain).not.toHaveBeenCalled();
        expect(fixture.afterHook).not.toHaveBeenCalled();
        expect.soft(fixture.updates).not.toHaveBeenCalled();
        expect(postEffects).not.toHaveBeenCalled();
      });
    },
  );

  it.each(["active", "closed", "replaced", "writer-replaced"] as const)(
    "binds a retained maintenance rewrite to its %s owner",
    async (owner) => {
      await withRecoveryFixture({}, async (fixture) => {
        let retainedRewrite: ContextEngineRuntimeContext["rewriteTranscriptEntries"];
        fixture.maintain.mockImplementationOnce(async ({ runtimeContext }) => {
          retainedRewrite = runtimeContext?.rewriteTranscriptEntries;
          return { changed: false, rewrittenEntries: 0, bytesFreed: 0 };
        });
        await expect(fixture.recover("overflow")).resolves.toEqual({ action: "retry" });
        if (!retainedRewrite) {
          throw new Error("Maintenance must receive the host-owned rewrite capability");
        }
        const before = await fixture.snapshot();
        fixture.updates.mockClear();
        if (owner !== "active") {
          const retainedWriter = fixture.openWriter();
          await fixture.invalidate(owner);
          if (owner === "writer-replaced") {
            // The existing SQLite fence works for an explicitly fenced manager;
            // the retained capability must not reopen an unfenced replacement.
            expect(() => retainedWriter.appendMessage(fixture.replacement.message)).toThrow();
          }
        }

        const rewrite = retainedRewrite({ replacements: [fixture.replacement] });
        if (owner === "active") {
          await expect(rewrite).resolves.toMatchObject({ changed: true, rewrittenEntries: 1 });
          const after = await fixture.snapshot();
          expect(after.eventDigests.slice(0, before.eventDigests.length)).toEqual(
            before.eventDigests,
          );
          expect(after.leafId).not.toBe(before.leafId);
          expect(fixture.updates).toHaveBeenCalled();
        } else {
          await expect.soft(rewrite).rejects.toBeInstanceOf(Error);
          expect.soft(await fixture.snapshot()).toEqual(before);
          expect(fixture.updates).not.toHaveBeenCalled();
        }
      });
    },
  );

  it.each(["active", "aborted", "closed"] as const)(
    "requires liveness but no durable claim for %s caller-owned in-memory recovery",
    async (owner) => {
      await withRecoveryFixture({ inMemory: true }, async (fixture) => {
        const before = await fixture.snapshot();
        expect(fixture.loadEntry()).toBeUndefined();
        if (owner === "active") {
          await expect(fixture.recover("timeout")).resolves.toBe(true);
          expect((await fixture.snapshot()).compactionIds).toHaveLength(1);
          expect(fixture.recoveryState.autoCompactionCount).toBe(1);
        } else {
          if (owner === "aborted") {
            fixture.compact.mockImplementationOnce(({ abortSignal }) =>
              waitForCompactionAbort(abortSignal, () => queueMicrotask(fixture.stop)),
            );
            await expect.soft(fixture.recover("timeout")).rejects.toBe(fixture.callerError);
          } else {
            fixture.compact.mockImplementationOnce(async () => {
              await fixture.invalidate("closed");
              throw new Error("engine failed after in-memory admission closed");
            });
            await expect.soft(fixture.recover("timeout")).rejects.toBeInstanceOf(Error);
          }
          expect(await fixture.snapshot()).toEqual(before);
          expect(fixture.afterHook).not.toHaveBeenCalled();
          fixture.expectNoContinuation();
        }
        expect(fixture.loadEntry()).toBeUndefined();
        expect(fixture.getCommittedSuccessor()).toBeUndefined();
      });
    },
  );
});
