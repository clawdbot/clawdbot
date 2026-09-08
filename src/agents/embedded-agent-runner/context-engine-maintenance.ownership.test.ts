import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  loadTranscriptEvents,
  replaceSessionEntry,
  replaceTranscriptEvents,
} from "../../config/sessions/session-accessor.js";
import type { ContextEngine } from "../../context-engine/types.js";
import { resetCommandQueueStateForTest } from "../../process/command-queue.test-support.js";
import { onSessionTranscriptUpdate } from "../../sessions/transcript-events.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { listTasksForOwnerKey } from "../../tasks/task-registry.js";
import {
  resetTaskFlowRegistryForTests,
  resetTaskRegistryForTests,
} from "../../tasks/task-runtime.test-helpers.js";
import { withStateDirEnv } from "../../test-helpers/state-dir-env.js";
import { SessionManager } from "../sessions/index.js";
import {
  runContextEngineMaintenance,
  waitForDeferredTurnMaintenanceForSession,
} from "./context-engine-maintenance.js";

vi.mock("./context-engine-capabilities.js", () => ({
  resolveContextEngineCapabilities: () => ({}),
}));

const modes = [undefined, "background"] as const;
const replacement = { role: "user" as const, content: "rewritten memory", timestamp: 1 };

function createEngine(maintain: NonNullable<ContextEngine["maintain"]>): ContextEngine {
  return {
    info: { id: "ownership-test", name: "Ownership test", turnMaintenanceMode: "background" },
    ingest: async () => ({ ingested: true }),
    assemble: async ({ messages }) => ({ messages, estimatedTokens: 0 }),
    compact: async () => ({ ok: true, compacted: false }),
    maintain,
  };
}

async function withTranscriptOwners(
  run: (owners: Awaited<ReturnType<typeof createTranscriptOwners>>) => Promise<void>,
) {
  await withStateDirEnv("openclaw-maintenance-owners-", async ({ stateDir }) => {
    resetCommandQueueStateForTest();
    resetTaskRegistryForTests({ persist: false });
    resetTaskFlowRegistryForTests({ persist: false });
    const owners = await createTranscriptOwners(stateDir);
    try {
      await run(owners);
    } finally {
      await waitForDeferredTurnMaintenanceForSession(owners.target.sessionKey);
      resetCommandQueueStateForTest();
      resetTaskRegistryForTests({ persist: false });
      resetTaskFlowRegistryForTests({ persist: false });
    }
  });
}

async function createTranscriptOwners(stateDir: string) {
  const memory = SessionManager.inMemory(stateDir);
  const entryId = memory.appendMessage({
    role: "user",
    content: "memory ".repeat(40),
    timestamp: 1,
  });
  memory.appendMessage({ role: "user", content: "memory tail", timestamp: 2 });
  const target = {
    agentId: "main",
    sessionId: memory.getSessionId(),
    sessionKey: "agent:main:maintenance-owner",
    storePath: path.join(stateDir, "sessions.json"),
  };
  await replaceSessionEntry(target, { sessionId: target.sessionId, updatedAt: 1 });
  // Matching IDs model copied history; ownership must not be inferred from identity.
  const durableEntries = structuredClone(memory.getEntries());
  for (const entry of durableEntries) {
    if (entry.type === "message") {
      entry.message = { role: "user", content: "durable-only sentinel", timestamp: 1 };
    }
  }
  await replaceTranscriptEvents(target, [memory.getHeader(), ...durableEntries]);
  const durable = SessionManager.open(target, stateDir);
  const durableBefore = await loadTranscriptEvents(target);
  return {
    memory,
    durable,
    durableBefore,
    entryId,
    target,
    params: {
      ...target,
      sessionTarget: target,
      sessionFile: `in-memory:${memory.getSessionId()}`,
      reason: "turn" as const,
    },
  };
}

describe("context-engine maintenance transcript ownership", () => {
  it.each(modes)("joins caller memory rewrite with executionMode=%s", async (executionMode) => {
    await withTranscriptOwners(async ({ memory, durableBefore, entryId, target, params }) => {
      const manager = executionMode
        ? SessionManager.fromEntries(memory.getPersistedEntries())
        : memory;
      const release = createDeferredCore();
      const deferred: Promise<void>[] = [];
      const events: string[] = [];
      const published = vi.fn();
      const unsubscribe = onSessionTranscriptUpdate(published);
      const open = vi.spyOn(SessionManager, "open");
      const maintain = vi.fn<NonNullable<ContextEngine["maintain"]>>(async ({ runtimeContext }) => {
        await release.promise;
        expect.soft(runtimeContext?.allowDeferredCompactionExecution).toBeUndefined();
        const result = await runtimeContext!.rewriteTranscriptEntries!({
          replacements: [{ entryId, message: replacement }],
        });
        events.push("maintained");
        return result;
      });
      const run = runContextEngineMaintenance({
        ...params,
        executionMode,
        sessionManager: manager,
        contextEngine: createEngine(maintain),
        withSessionManagerRewriteLock: async (operation) => {
          events.push("locked");
          try {
            return await operation();
          } finally {
            events.push("unlocked");
          }
        },
        onDeferredMaintenance: (promise) => deferred.push(promise),
      }).then((result) => {
        events.push("returned");
        return result;
      });
      try {
        await vi.waitFor(() => expect(maintain).toHaveBeenCalledOnce());
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        expect.soft(events).not.toContain("returned");
        release.resolve();
        const result = await run;
        await Promise.all(deferred);
        expect.soft(result).toMatchObject({ changed: true, rewrittenEntries: 1 });
        expect
          .soft(manager.getBranch().map((entry) => entry.type === "message" && entry.message))
          .toEqual([replacement, { role: "user", content: "memory tail", timestamp: 2 }]);
        expect.soft(events).toEqual(["locked", "unlocked", "maintained", "returned"]);
        expect.soft(open).not.toHaveBeenCalled();
        expect.soft(published).not.toHaveBeenCalled();
        expect.soft(await loadTranscriptEvents(target)).toEqual(durableBefore);
        expect.soft(deferred).toHaveLength(0);
        expect.soft(listTasksForOwnerKey(target.sessionKey)).toHaveLength(0);
      } finally {
        release.resolve();
        await Promise.allSettled([run, ...deferred]);
        open.mockRestore();
        unsubscribe();
      }
    });
  });

  it.each(modes)(
    "reopens and publishes durable background rewrites with executionMode=%s",
    async (executionMode) => {
      await withTranscriptOwners(async ({ durable, entryId, target, params }) => {
        const deferred: Promise<void>[] = [];
        const published = vi.fn();
        const unsubscribe = onSessionTranscriptUpdate(published);
        const open = vi.spyOn(SessionManager, "open");
        const lock = vi.fn();
        const run = runContextEngineMaintenance({
          ...params,
          executionMode,
          sessionManager: durable,
          withSessionManagerRewriteLock: async (operation) => {
            lock();
            return await operation();
          },
          contextEngine: createEngine(async ({ runtimeContext }) => {
            expect(runtimeContext?.allowDeferredCompactionExecution).toBe(true);
            return await runtimeContext!.rewriteTranscriptEntries!({
              replacements: [{ entryId, message: replacement }],
            });
          }),
          onDeferredMaintenance: (promise) => deferred.push(promise),
        });
        try {
          await run;
          await Promise.all(deferred);
          expect(open).toHaveBeenCalledExactlyOnceWith(target);
          expect(lock).not.toHaveBeenCalled();
          expect(published).toHaveBeenCalledExactlyOnceWith({
            agentId: target.agentId,
            sessionId: target.sessionId,
            sessionKey: target.sessionKey,
            target: {
              agentId: target.agentId,
              sessionId: target.sessionId,
              sessionKey: target.sessionKey,
            },
          });
          expect(SessionManager.open(target).getBranch()[0]).toMatchObject({
            message: replacement,
          });
          expect(durable.getBranch()[0]).toMatchObject({
            message: { content: "durable-only sentinel" },
          });
          expect(deferred).toHaveLength(executionMode ? 0 : 1);
          expect(listTasksForOwnerKey(target.sessionKey).map((task) => task.status)).toEqual(
            executionMode ? [] : ["succeeded"],
          );
        } finally {
          await Promise.allSettled([run, ...deferred]);
          open.mockRestore();
          unsubscribe();
        }
      });
    },
  );

  it.each(modes)(
    "does not coalesce or wait for foreign durable work with executionMode=%s",
    async (executionMode) => {
      await withTranscriptOwners(async ({ memory, durable, params, target }) => {
        const release = createDeferredCore();
        const foreignMaintain = vi.fn(async () => {
          await release.promise;
          return { changed: false, rewrittenEntries: 0, bytesFreed: 0 };
        });
        const deferred: Promise<void>[] = [];
        await runContextEngineMaintenance({
          ...params,
          sessionManager: durable,
          contextEngine: createEngine(foreignMaintain),
          onDeferredMaintenance: (promise) => deferred.push(promise),
        });
        let run: Promise<unknown> | undefined;
        try {
          await vi.waitFor(() => expect(foreignMaintain).toHaveBeenCalledOnce());
          const tasksBefore = listTasksForOwnerKey(target.sessionKey);
          const maintain = vi.fn(async () => ({
            changed: false,
            rewrittenEntries: 0,
            bytesFreed: 0,
          }));
          run = runContextEngineMaintenance({
            ...params,
            executionMode,
            sessionManager: memory,
            contextEngine: createEngine(maintain),
            onDeferredMaintenance: (promise) => deferred.push(promise),
          });
          await expect(run).resolves.toMatchObject({ changed: false });
          expect(maintain).toHaveBeenCalledOnce();
          expect(deferred).toHaveLength(1);
          expect(listTasksForOwnerKey(target.sessionKey)).toEqual(tasksBefore);
        } finally {
          release.resolve();
          await Promise.allSettled([...(run ? [run] : []), ...deferred]);
        }
        expect(listTasksForOwnerKey(target.sessionKey).map((task) => task.status)).toEqual([
          "succeeded",
        ]);
      });
    },
  );

  it.each([
    { fence: "abort", stage: "lock" },
    { fence: "activity", stage: "lock" },
    { fence: "abort", stage: "maintenance" },
    { fence: "activity", stage: "maintenance" },
  ] as const)("fences caller memory on $fence after awaited $stage", async ({ fence, stage }) => {
    await withTranscriptOwners(async ({ memory, durableBefore, target, entryId, params }) => {
      const before = structuredClone(memory.getPersistedEntries());
      const entered = vi.fn();
      const release = createDeferredCore();
      const controller = new AbortController();
      const closed = new Error("caller maintenance owner closed");
      let active = true;
      const run = runContextEngineMaintenance({
        ...params,
        executionMode: "background",
        sessionManager: memory,
        abortSignal: controller.signal,
        assertActive: () => {
          controller.signal.throwIfAborted();
          if (!active) {
            throw closed;
          }
        },
        withSessionManagerRewriteLock: async (operation) => {
          entered();
          await release.promise;
          return await operation();
        },
        contextEngine: createEngine(async ({ runtimeContext, abortSignal }) => {
          expect(abortSignal).toBe(controller.signal);
          if (stage === "maintenance") {
            entered();
            await release.promise;
            return { changed: false, rewrittenEntries: 0, bytesFreed: 0 };
          }
          return await runtimeContext!.rewriteTranscriptEntries!({
            replacements: [{ entryId, message: replacement }],
          });
        }),
      });
      const outcome = run.then(
        (result) => result,
        (error: unknown) => error,
      );
      try {
        await vi.waitFor(() => expect(entered).toHaveBeenCalledOnce());
        if (fence === "abort") {
          controller.abort(closed);
        } else {
          active = false;
        }
        release.resolve();
        expect(await outcome).toBe(closed);
        expect(memory.getPersistedEntries()).toEqual(before);
        expect(await loadTranscriptEvents(target)).toEqual(durableBefore);
      } finally {
        release.resolve();
        await Promise.allSettled([run, outcome]);
      }
    });
  });
});
