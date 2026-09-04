import { AsyncLocalStorage } from "node:async_hooks";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ContextEngine, ContextEngineRuntimeContext } from "../../context-engine/types.js";
import {
  acquireAgentRunPreparedModelRuntimeMock,
  contextEngineCompactMock,
  hookRunner,
  loadCompactHooksHarness,
  maybeCompactAgentHarnessSessionMock,
  resetCompactHooksHarnessMocks,
  resolveContextEngineMock,
} from "./compact.hooks.harness.js";
import type { AcceptedCompactionSuccessor } from "./compaction-successor.js";

const { compactEmbeddedAgentSession: compact } = await loadCompactHooksHarness();
// The harness resets modules. Load every real owner afterward so the manager
// and queued compaction share the same private write context and database lifetime.
const [
  { incrementCompactionCount },
  {
    loadSessionEntry,
    loadTranscriptEventsSync,
    patchSessionEntryCore,
    replaceSessionEntrySync,
    upsertSessionEntryCore,
  },
  { closeOpenClawAgentDatabasesForTest },
  { SessionManager: PersistentSessionManager },
  safetyTimeout,
  realSafetyTimeout,
  { compactionCheckpointStore },
  { resolveGatewaySessionStoreTarget },
  { markRuntimeCompactionDelegate },
] = await Promise.all([
  import("../../auto-reply/reply/session-updates.js"),
  import("../../config/sessions/session-accessor.js"),
  import("../../state/openclaw-agent-db.js"),
  import("../sessions/session-manager.js"),
  import("./compaction-safety-timeout.js"),
  vi.importActual<typeof import("./compaction-safety-timeout.js")>(
    "./compaction-safety-timeout.js",
  ),
  import("./compaction-checkpoint.js"),
  import("../../gateway/session-utils.js"),
  import("../../context-engine/compaction-watchdog.js"),
]);

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
    cleanup();
  }),
);
let workspaceDir: string;
const sessionId = "predecessor";
const sessionKey = "agent:main:queued-successor";
const owner = { sessionId, lifecycleRevision: "lifecycle", activeWriterRunId: "writer" };
const maintain = vi.fn<NonNullable<ContextEngine["maintain"]>>(async () => ({
  changed: false,
  bytesFreed: 0,
  rewrittenEntries: 0,
}));
const target = () => ({
  agentId: "main",
  sessionId,
  sessionKey,
  storePath: join(workspaceDir, "sessions.sqlite"),
});
const compactParams = (abortSignal?: AbortSignal) => ({
  ...target(),
  sessionTarget: target(),
  sessionFile: sessionKey,
  sessionEntry: { ...owner, updatedAt: 1 },
  workspaceDir,
  provider: "codex",
  model: "test-model",
  agentHarnessId: "codex",
  abortSignal,
  enqueue: async <T>(task: () => Promise<T> | T) => await task(),
});
const completed = (resultSessionId = "successor") => ({
  ok: true,
  compacted: true,
  result: { sessionId: resultSessionId, summary: "summary", tokensBefore: 120, tokensAfter: 40 },
});

const backendCompactParams = (abortSignal?: AbortSignal) => ({
  ...compactParams(abortSignal),
  provider: "openai",
  agentHarnessId: "openclaw",
});

function createBackendAppend(firstKeptEntryId: string) {
  // Open exactly the portable target the backend receives; the test supplies no fence.
  const manager = PersistentSessionManager.open(target(), workspaceDir);
  return () => {
    try {
      manager.appendCompaction("backend summary", firstKeptEntryId, 120);
      return { written: true as const };
    } catch (error) {
      return { written: false as const, error };
    }
  };
}

type BackendAppendOutcome = ReturnType<ReturnType<typeof createBackendAppend>>;
type TranscriptRewrite = NonNullable<ContextEngineRuntimeContext["rewriteTranscriptEntries"]>;

async function withPersistentTranscriptFixture(
  run: (fixture: {
    entryId: string;
    request: Parameters<TranscriptRewrite>[0];
    transcriptBefore: unknown[];
    hooks: { beforeBranchRead?: () => void };
  }) => Promise<void>,
) {
  const { SessionManager } = await import("../sessions/index.js");
  const open = vi.spyOn(SessionManager, "open");
  const originalOpen = open.getMockImplementation();
  if (!originalOpen) {
    throw new Error("expected the queued fixture's session-manager bridge");
  }
  const hooks: { beforeBranchRead?: () => void } = {};
  open.mockImplementation((...args) => {
    const manager = PersistentSessionManager.open(...args);
    const getBranch = manager.getBranch.bind(manager);
    vi.spyOn(manager, "getBranch").mockImplementation((...branchArgs) => {
      hooks.beforeBranchRead?.();
      return getBranch(...branchArgs);
    });
    return manager;
  });
  try {
    const manager = PersistentSessionManager.open(target(), workspaceDir);
    const entryId = manager.appendMessage({
      role: "user",
      content: "original history ".repeat(20),
      timestamp: 1,
    });
    await run({
      entryId,
      request: {
        replacements: [{ entryId, message: { role: "user", content: "rewritten", timestamp: 2 } }],
      },
      transcriptBefore: loadTranscriptEventsSync(target()),
      hooks,
    });
  } finally {
    open.mockImplementation(originalOpen);
  }
}

beforeEach(async () => {
  workspaceDir = await realpath(tempDirs.make("openclaw-queued-successor-"));
  resetCompactHooksHarnessMocks(workspaceDir);
  maintain.mockClear();
  hookRunner.hasHooks.mockReturnValue(true);
  resolveContextEngineMock.mockResolvedValue({
    info: { id: "test-engine", name: "Test engine", ownsCompaction: true },
    compact: contextEngineCompactMock,
    maintain,
  } as never);
  contextEngineCompactMock.mockResolvedValue(completed());
  await upsertSessionEntryCore(target(), { ...owner, updatedAt: 1 });
});

describe("queued compaction successor ownership", () => {
  it.each([
    { nativePinned: false, observedHarness: "openclaw" },
    { nativePinned: false, observedHarness: "codex" },
    { nativePinned: true, observedHarness: "codex" },
  ])(
    "keeps manual compaction with its transcript owner after authored runtime fallback (nativePinned=$nativePinned, observed=$observedHarness)",
    async ({ nativePinned, observedHarness }) => {
      const [
        { resolveManualCompactionCliTarget },
        registry,
        selection,
        actualSelection,
        { requireActivePluginRegistry },
      ] = await Promise.all([
        import("../session-runtime-compat.js"),
        import("../harness/registry.js"),
        import("../harness/selection.js"),
        vi.importActual<typeof import("../harness/selection.js")>("../harness/selection.js"),
        import("../../plugins/runtime.js"),
      ]);
      const select = vi.mocked(selection.selectAgentHarness);
      const selectPrepared = vi.mocked(selection.selectAgentHarnessForPreparedModelProviders);
      const previousSelect = select.getMockImplementation()!;
      const previousSelectPrepared = selectPrepared.getMockImplementation()!;
      select.mockImplementation(actualSelection.selectAgentHarness);
      selectPrepared.mockImplementation(
        actualSelection.selectAgentHarnessForPreparedModelProviders,
      );
      registry.registerAgentHarness({
        id: "codex",
        label: "Native compaction owner",
        authBootstrap: "harness",
        supports: (context) =>
          context.modelProvider?.requestTransportOverrides === "present"
            ? {
                supported: false,
                reason: "authored request requires host transport",
                fallbackRuntime: "openclaw",
              }
            : { supported: true },
        runAttempt: vi.fn(),
      });
      const pluginRegistry = requireActivePluginRegistry();
      const previousAcquire = acquireAgentRunPreparedModelRuntimeMock.getMockImplementation()!;
      // Prepared generations own registry lookup; an omitted registry deliberately means empty.
      acquireAgentRunPreparedModelRuntimeMock.mockImplementation(async (input) => {
        const lease = await previousAcquire(input);
        return { ...lease, snapshot: { ...lease.snapshot, pluginRegistry } };
      });
      const config: OpenClawConfig = {
        models: {
          providers: {
            openai: {
              api: "openai-responses",
              baseUrl: "https://api.openai.com/v1",
              models: [],
              ...(!nativePinned ? { headers: { "X-Compaction-Fixture": "preserve" } } : {}),
            },
          },
        },
        ...(!nativePinned
          ? {
              agents: {
                defaults: {
                  models: {
                    "openai/gpt-5.6-luna": { params: { temperature: 0.2 } },
                  },
                },
              },
            }
          : {}),
      };
      const entry: SessionEntry = {
        ...owner,
        updatedAt: 1,
        modelSelectionLocked: true,
        modelProvider: "openai",
        model: "gpt-5.6-luna",
        agentRuntimeOverride: nativePinned ? "openclaw" : "codex",
        agentHarnessId: observedHarness,
        ...(!nativePinned ? { pluginOwnerId: "model-owner" } : {}),
      };
      try {
        replaceSessionEntrySync(target(), entry);
        contextEngineCompactMock.mockResolvedValueOnce(completed(sessionId));
        const manualTarget = resolveManualCompactionCliTarget({
          provider: "openai",
          entry,
          cfg: config,
        });
        const result = await compact({
          ...compactParams(),
          ...manualTarget,
          provider: "openai",
          model: "gpt-5.6-luna",
          authProfileId: "openai:test",
          authProfileIdSource: "user",
          // A stale caller cannot add or remove the durable native owner.
          sessionEntry: { ...entry, pluginOwnerId: nativePinned ? "stale-owner" : undefined },
          agentHarnessId: nativePinned ? "openclaw" : manualTarget.agentHarnessId,
          modelSelectionLocked: true,
          config,
          trigger: "manual",
        });

        expect(result).toMatchObject(
          nativePinned
            ? { ok: false, compacted: false, failure: { reason: "model_selection_locked" } }
            : { ok: true, compacted: true },
        );
        expect(contextEngineCompactMock).toHaveBeenCalledTimes(nativePinned ? 0 : 1);
        expect(maybeCompactAgentHarnessSessionMock).toHaveBeenCalledTimes(nativePinned ? 1 : 0);
        if (!nativePinned) {
          expect(contextEngineCompactMock.mock.calls[0]?.[0].runtimeContext).toMatchObject({
            config,
            provider: "openai",
            model: "gpt-5.6-luna",
            agentHarnessId: "openclaw",
            modelSelectionLocked: true,
          });
        }
        expect(loadSessionEntry(target())).toMatchObject({
          sessionId,
          modelSelectionLocked: true,
          agentRuntimeOverride: entry.agentRuntimeOverride,
          agentHarnessId: entry.agentHarnessId,
          ...(!nativePinned ? { pluginOwnerId: "model-owner" } : {}),
        });
      } finally {
        acquireAgentRunPreparedModelRuntimeMock.mockImplementation(previousAcquire);
        registry.clearAgentHarnesses();
        select.mockImplementation(previousSelect);
        selectPrepared.mockImplementation(previousSelectPrepared);
      }
    },
  );

  it.each([false, true])(
    "commits the successor before observers, with caller abort=%s",
    async (abortAfterCommit) => {
      const controller = new AbortController();
      const onCommitted = vi.fn((accepted: AcceptedCompactionSuccessor) => {
        expect(loadSessionEntry(target())).toMatchObject({ ...owner, sessionId: "successor" });
        expect(accepted.entry).toMatchObject({ ...owner, sessionId: "successor" });
        if (abortAfterCommit) {
          controller.abort(new Error("caller closed after commit"));
        }
      });

      const result = await compact(compactParams(controller.signal), { onCommitted });

      expect(result).toMatchObject({
        ok: true,
        compacted: true,
        result: { sessionId: "successor", tokensAfter: 40 },
      });
      expect(onCommitted).toHaveBeenCalledOnce();
      expect(loadSessionEntry(target())).toMatchObject({ ...owner, sessionId: "successor" });
      expect(maintain).toHaveBeenCalledTimes(abortAfterCommit ? 0 : 1);
      expect(hookRunner.runAfterCompaction).toHaveBeenCalledTimes(abortAfterCommit ? 0 : 1);
      expect(maybeCompactAgentHarnessSessionMock).toHaveBeenCalledTimes(abortAfterCommit ? 0 : 1);
      const engineInput = contextEngineCompactMock.mock.calls[0]?.[0];
      expect(engineInput).toBeDefined();
      expect(engineInput?.runtimeContext).not.toHaveProperty("onCommitted");
      expect(engineInput?.runtimeContext?.sessionEntry).not.toHaveProperty("activeWriterRunId");
    },
  );

  it.each([
    { name: "same-ID compaction", successorId: sessionId, tokensAfter: 40 },
    { name: "declared but unaccepted successor", successorId: "successor", tokensAfter: undefined },
  ])("preserves completed $name when the first post-backend gate closes", async (scenario) => {
    const controller = new AbortController();
    let backendCompleted = false;
    contextEngineCompactMock.mockImplementationOnce(async () => {
      backendCompleted = true;
      return {
        ok: true,
        compacted: true,
        result: {
          sessionId: scenario.successorId,
          summary: "summary",
          tokensBefore: 120,
          tokensAfter: 40,
        },
      };
    });
    const onCommitted = vi.fn();
    const pending = compact(compactParams(controller.signal), {
      onCommitted,
      assertActive: () => {
        if (backendCompleted) {
          controller.abort(new Error("caller closed after backend completion"));
        }
        controller.signal.throwIfAborted();
      },
    });

    await expect(pending).resolves.toMatchObject({ ok: true, compacted: true });
    const result = await pending;
    expect(controller.signal.aborted).toBe(true);
    expect(result.result?.sessionId).toBeUndefined();
    expect(result.result?.sessionFile).toBeUndefined();
    expect(result.result?.tokensAfter).toBe(scenario.tokensAfter);
    expect(onCommitted).not.toHaveBeenCalled();
    expect(loadSessionEntry(target())).toMatchObject(owner);
    expect(maintain).not.toHaveBeenCalled();
    expect(hookRunner.runAfterCompaction).not.toHaveBeenCalled();
    expect(maybeCompactAgentHarnessSessionMock).not.toHaveBeenCalled();

    // The ordinary caller counter can retain completion, but cannot attach an
    // unaccepted successor's context snapshot to the predecessor's identity.
    const count =
      result.ok && result.compacted
        ? await incrementCompactionCount({
            agentId: "main",
            sessionKey,
            storePath: target().storePath,
            sessionStore: { [sessionKey]: { ...owner, updatedAt: 1 } },
            expectedSession: owner,
            tokensAfter: result.result?.tokensAfter,
          })
        : undefined;
    expect(count).toBe(1);
    expect(loadSessionEntry(target())).toMatchObject({ ...owner, compactionCount: 1 });
    expect(loadSessionEntry(target())?.totalTokens).toBe(scenario.tokensAfter);
  });

  it.each([
    { lifecycleRevision: "replacement-lifecycle" },
    { activeWriterRunId: "replacement-writer" },
  ])("rejects an owner changed while compaction awaited: %j", async (replacement) => {
    contextEngineCompactMock.mockImplementationOnce(async () => {
      await patchSessionEntryCore(target(), () => replacement);
      return completed();
    });
    const onCommitted = vi.fn();

    await expect(compact(compactParams(), { onCommitted })).rejects.toThrow();

    expect(loadSessionEntry(target())).toMatchObject({ ...owner, ...replacement });
    expect(onCommitted).not.toHaveBeenCalled();
    expect(maintain).not.toHaveBeenCalled();
    expect(hookRunner.runAfterCompaction).not.toHaveBeenCalled();
    expect(maybeCompactAgentHarnessSessionMock).not.toHaveBeenCalled();
  });

  it.each([
    { capturedWriter: "writer", takeover: false },
    { capturedWriter: undefined, takeover: false },
    { capturedWriter: "writer", takeover: true },
    { capturedWriter: undefined, takeover: true },
  ])(
    "binds backend append to the captured writer (captured=$capturedWriter, takeover=$takeover)",
    async ({ capturedWriter, takeover }) => {
      const capturedEntry = { ...owner, updatedAt: 1, activeWriterRunId: capturedWriter };
      replaceSessionEntrySync(target(), capturedEntry);
      await withPersistentTranscriptFixture(async ({ entryId, transcriptBefore }) => {
        const entered = createDeferred();
        const release = createDeferred();
        const observed = createDeferred<BackendAppendOutcome>();
        contextEngineCompactMock.mockImplementationOnce(async () => {
          const append = createBackendAppend(entryId);
          entered.resolve();
          await release.promise;
          const outcome = append();
          observed.resolve(outcome);
          if (!outcome.written) {
            throw outcome.error;
          }
          return completed(sessionId);
        });
        const pending = compact({
          ...backendCompactParams(),
          sessionEntry: capturedEntry,
        }).catch((error: unknown) => error);
        try {
          await Promise.race([
            entered.promise,
            pending.then(() => {
              throw new Error("Queued compaction settled before the backend checkpoint");
            }),
          ]);
          if (takeover) {
            replaceSessionEntrySync(target(), {
              ...capturedEntry,
              updatedAt: 2,
              activeWriterRunId: "replacement-writer",
            });
          }
          const entryBeforeAppend = structuredClone(
            loadSessionEntry({ ...target(), readConsistency: "latest" }),
          );
          expect(entryBeforeAppend).toBeDefined();
          release.resolve();
          const result = await pending;
          const outcome = await observed.promise;
          const transcriptAfter = loadTranscriptEventsSync(target());
          const after = loadSessionEntry({ ...target(), readConsistency: "latest" });

          if (takeover) {
            expect(transcriptAfter).toEqual(transcriptBefore);
            expect(after).toEqual(entryBeforeAppend);
            expect(outcome).toMatchObject({ written: false, error: expect.any(Error) });
            expect(result).toMatchObject({ ok: false, compacted: false });
          } else {
            expect(transcriptAfter.slice(0, transcriptBefore.length)).toEqual(transcriptBefore);
            expect(transcriptAfter).toHaveLength(transcriptBefore.length + 1);
            expect(transcriptAfter.at(-1)).toMatchObject({
              type: "compaction",
              summary: "backend summary",
              firstKeptEntryId: entryId,
              tokensBefore: 120,
            });
            expect(after?.sessionId).toBe(sessionId);
            expect(after?.lifecycleRevision).toBe(owner.lifecycleRevision);
            expect(after?.activeWriterRunId).toBe(capturedWriter);
            expect(outcome).toEqual({ written: true });
            expect(result).toMatchObject({ ok: true, compacted: true });
          }
          expect(contextEngineCompactMock).toHaveBeenCalledOnce();
          expect(maintain).toHaveBeenCalledTimes(takeover ? 0 : 1);
        } finally {
          release.resolve();
          await pending;
        }
      });
    },
  );

  it("rejects an inherited backend continuation after the queued owner closes", async () => {
    await withPersistentTranscriptFixture(async ({ entryId, transcriptBefore }) => {
      const release = createDeferred();
      let continuation: Promise<BackendAppendOutcome> | undefined;
      contextEngineCompactMock.mockImplementationOnce(async () => {
        const append = createBackendAppend(entryId);
        // Create the continuation inside the backend so it inherits the actual
        // queued context, rather than injecting a private fence from this test.
        continuation = (async () => {
          await release.promise;
          return append();
        })();
        return { ok: true, compacted: false };
      });
      const pending = compact(backendCompactParams());
      try {
        await expect(pending).resolves.toMatchObject({ ok: true, compacted: false });
        if (!continuation) {
          throw new Error("Expected the backend's retained async continuation");
        }
        const closedEntry = structuredClone(
          loadSessionEntry({ ...target(), readConsistency: "latest" }),
        );
        expect(closedEntry).toBeDefined();
        release.resolve();
        const outcome = await continuation;

        expect(loadTranscriptEventsSync(target())).toEqual(transcriptBefore);
        expect(loadSessionEntry({ ...target(), readConsistency: "latest" })).toEqual(closedEntry);
        expect(outcome).toMatchObject({ written: false, error: expect.any(Error) });
        expect(contextEngineCompactMock).toHaveBeenCalledOnce();
      } finally {
        release.resolve();
        await pending.catch(() => undefined);
        await continuation;
      }
    });
  });

  it.each(["plugin", "delegate"] as const)(
    "fences a synchronous timeout-listener append while the caller remains active (%s)",
    async (engineKind) => {
      await withPersistentTranscriptFixture(async ({ entryId, transcriptBefore }) => {
        const boundedCompact = vi.mocked(safetyTimeout.compactContextEngineWithSafetyTimeout);
        const previousImplementation = boundedCompact.getMockImplementation();
        if (!previousImplementation) {
          throw new Error("Expected the suite's replaceable safety-timeout mock");
        }
        const caller = new AbortController();
        const releaseBackend = createDeferred();
        const observed = createDeferred<{
          outcome: BackendAppendOutcome;
          callerAborted: boolean;
          queuedSettled: boolean;
        }>();
        let backendSignal: AbortSignal | undefined;
        let progressReset: unknown;
        let backendWork: ReturnType<ContextEngine["compact"]> | undefined;
        let queuedSettled = false;
        // A fresh function keeps the process-wide delegate tag off the shared mock.
        const backend = vi.fn<ContextEngine["compact"]>((params) =>
          contextEngineCompactMock(params),
        );
        const engine = {
          info: {
            id: "timeout-fixture",
            name: "Timeout fixture",
            ownsCompaction: engineKind === "plugin",
          },
          compact: engineKind === "delegate" ? markRuntimeCompactionDelegate(backend) : backend,
          maintain,
        };
        resolveContextEngineMock.mockResolvedValueOnce(engine);
        contextEngineCompactMock.mockImplementationOnce((backendParams) => {
          const signal = backendParams.abortSignal;
          if (!signal) {
            throw new Error("Expected the real safety wrapper's composed backend signal");
          }
          backendSignal = signal;
          progressReset = backendParams.runtimeContext?.compactionTimeoutReset;
          const append = createBackendAppend(entryId);
          // Timer dispatch owns a different async context. Retain the backend's
          // actual context without constructing any OpenClaw authority in the fixture.
          const onAbort = AsyncLocalStorage.bind(() => {
            observed.resolve({
              callerAborted: caller.signal.aborted,
              queuedSettled,
              outcome: append(),
            });
          });
          signal.addEventListener("abort", onAbort, { once: true });
          backendWork = (async () => {
            try {
              await releaseBackend.promise;
              return { ok: true, compacted: false };
            } finally {
              signal.removeEventListener("abort", onAbort);
            }
          })();
          return backendWork;
        });
        const entryBefore = structuredClone(
          loadSessionEntry({ ...target(), readConsistency: "latest" }),
        );
        expect(entryBefore).toBeDefined();
        // Override the existing mocked function, not the shared harness or module
        // epoch. The real helper owns composition, timer abortion, and the race.
        boundedCompact.mockImplementation((ownedCompactor, params, _timeoutMs, signal) =>
          realSafetyTimeout.compactContextEngineWithSafetyTimeout(
            ownedCompactor,
            params,
            1,
            signal,
          ),
        );
        const pending = compact(backendCompactParams(caller.signal)).then(
          (result) => {
            queuedSettled = true;
            return result;
          },
          (error: unknown) => {
            queuedSettled = true;
            throw error;
          },
        );
        try {
          await expect(pending).resolves.toMatchObject({ ok: false, compacted: false });
          expect(backendSignal).not.toBe(caller.signal);
          expect(backendSignal?.aborted).toBe(true);
          const observation = await observed.promise;

          expect(observation.callerAborted).toBe(false);
          expect(observation.queuedSettled).toBe(false);
          expect(caller.signal.aborted).toBe(false);
          expect(loadTranscriptEventsSync(target())).toEqual(transcriptBefore);
          expect(loadSessionEntry({ ...target(), readConsistency: "latest" })).toEqual(entryBefore);
          expect(observation.outcome).toMatchObject({ written: false, error: expect.any(Error) });
          expect
            .soft(typeof progressReset)
            .toBe(engineKind === "delegate" ? "function" : "undefined");
          expect(backend).toHaveBeenCalledOnce();
          expect(contextEngineCompactMock).toHaveBeenCalledOnce();
          expect(maintain).not.toHaveBeenCalled();
        } finally {
          boundedCompact.mockImplementation(previousImplementation);
          releaseBackend.resolve();
          await pending.catch(() => undefined);
          await backendWork;
        }
      });
    },
  );

  it.each([false, true])(
    "preserves completed compaction and binds real checkpoint persistence (abort=%s)",
    async (abortBeforePersist) => {
      await withPersistentTranscriptFixture(async ({ entryId, transcriptBefore }) => {
        const caller = new AbortController();
        const abortReason = new Error("caller closed during checkpoint planning");
        const config = { session: { store: target().storePath } };
        const checkpointTarget = resolveGatewaySessionStoreTarget({
          cfg: config,
          key: sessionKey,
          agentId: "main",
        });
        expect(checkpointTarget).toMatchObject({
          agentId: "main",
          storePath: target().storePath,
          canonicalKey: sessionKey,
        });
        const entered = createDeferred();
        const release = createDeferred();
        const persistCheckpoint =
          compactionCheckpointStore.persistCheckpoint.bind(compactionCheckpointStore);
        const observed = createDeferred<
          | { kind: "returned"; checkpoint: Awaited<ReturnType<typeof persistCheckpoint>> }
          | { kind: "threw"; error: unknown }
        >();
        const persist = vi
          .spyOn(compactionCheckpointStore, "persistCheckpoint")
          .mockImplementation(async (params) => {
            entered.resolve();
            await release.promise;
            // Capture the real store outcome before the production wrapper can
            // swallow a fixture error and make the negative case pass vacuously.
            try {
              const checkpoint = await persistCheckpoint(params);
              observed.resolve({ kind: "returned", checkpoint });
              return checkpoint;
            } catch (error) {
              observed.resolve({ kind: "threw", error });
              throw error;
            }
          });
        contextEngineCompactMock.mockResolvedValueOnce(completed(sessionId));
        const pending = compact({ ...backendCompactParams(caller.signal), config });
        try {
          await Promise.race([
            entered.promise,
            pending.then(() => {
              throw new Error("Queued compaction skipped the real checkpoint persistence boundary");
            }),
          ]);
          expect(persist.mock.calls[0]?.[0]).toMatchObject({
            sessionId,
            sessionKey,
            snapshot: { sessionId, leafId: entryId },
            postLeafId: entryId,
          });
          const entryAtCheckpoint = structuredClone(
            loadSessionEntry({ ...target(), readConsistency: "latest" }),
          );
          if (!entryAtCheckpoint) {
            throw new Error("Expected the canonical row before checkpoint persistence");
          }
          expect(entryAtCheckpoint.compactionCheckpoints).toBeUndefined();
          if (abortBeforePersist) {
            caller.abort(abortReason);
          }
          release.resolve();
          const result = await pending;
          const storeOutcome = await observed.promise;

          expect(persist).toHaveBeenCalledOnce();
          expect(contextEngineCompactMock).toHaveBeenCalledOnce();
          expect(result).toMatchObject({
            ok: true,
            compacted: true,
            result: { tokensAfter: 40 },
          });
          const after = loadSessionEntry({ ...target(), readConsistency: "latest" });
          if (abortBeforePersist) {
            expect(after?.compactionCheckpoints).toEqual(entryAtCheckpoint.compactionCheckpoints);
            expect(after).toEqual(entryAtCheckpoint);
            expect(storeOutcome).toEqual({ kind: "threw", error: abortReason });
          } else {
            expect(storeOutcome.kind).toBe("returned");
            if (storeOutcome.kind !== "returned" || !storeOutcome.checkpoint) {
              throw new Error("Active checkpoint persistence did not return a stored checkpoint");
            }
            const checkpoint = storeOutcome.checkpoint;
            expect(checkpoint).toMatchObject({
              sessionId,
              sessionKey,
              preCompaction: { sessionId, leafId: entryId },
              postCompaction: { sessionId, leafId: entryId },
            });
            expect(after?.updatedAt).toBeGreaterThanOrEqual(checkpoint.createdAt);
            expect(after).toEqual({
              ...entryAtCheckpoint,
              updatedAt: after?.updatedAt,
              compactionCheckpoints: [checkpoint],
            });
          }
          expect(loadTranscriptEventsSync(target())).toEqual(transcriptBefore);
          expect(maintain).toHaveBeenCalledTimes(abortBeforePersist ? 0 : 1);
          expect(hookRunner.runAfterCompaction).toHaveBeenCalledTimes(abortBeforePersist ? 0 : 1);
        } finally {
          release.resolve();
          await pending.catch(() => undefined);
          persist.mockRestore();
        }
      });
    },
  );

  it("does not resolve or adopt successor fields from a failed compaction", async () => {
    contextEngineCompactMock.mockResolvedValueOnce({
      ok: false,
      compacted: true,
      reason: "provider failed",
      result: {
        tokensBefore: 120,
        sessionTarget: { sessionId: "untrusted", sessionKey: "agent:other:other" },
      },
    });

    await expect(compact(compactParams())).resolves.toMatchObject({
      ok: false,
      reason: "provider failed",
    });

    expect(loadSessionEntry(target())).toMatchObject(owner);
    expect(maintain).not.toHaveBeenCalled();
    expect(hookRunner.runAfterCompaction).not.toHaveBeenCalled();
  });

  it("rejects retained queued maintenance rewrites after normal closure", async () => {
    await withPersistentTranscriptFixture(async ({ request, transcriptBefore }) => {
      const retained: { rewrite?: TranscriptRewrite } = {};
      contextEngineCompactMock.mockResolvedValueOnce(completed(sessionId));
      maintain.mockImplementationOnce(async ({ runtimeContext }) => {
        retained.rewrite = runtimeContext?.rewriteTranscriptEntries;
        return { changed: false, bytesFreed: 0, rewrittenEntries: 0 };
      });

      await expect(compact(compactParams())).resolves.toMatchObject({ ok: true, compacted: true });
      if (!retained.rewrite) {
        throw new Error("expected a retained maintenance rewrite capability");
      }
      await expect(retained.rewrite(request)).rejects.toThrow();

      expect(loadTranscriptEventsSync(target())).toEqual(transcriptBefore);
      expect(loadSessionEntry(target())).toMatchObject(owner);
    });
  });

  it.each([
    { replacementPoint: "before rewrite", capturedWriter: "writer" },
    { replacementPoint: "during branch read", capturedWriter: "writer" },
    { replacementPoint: "before rewrite", capturedWriter: undefined },
    { replacementPoint: "during branch read", capturedWriter: undefined },
  ] as const)(
    "fences a queued maintenance writer replacement after acceptance: $replacementPoint (captured=$capturedWriter)",
    async ({ replacementPoint, capturedWriter }) => {
      const capturedEntry = { ...owner, updatedAt: 1, activeWriterRunId: capturedWriter };
      replaceSessionEntrySync(target(), capturedEntry);
      await withPersistentTranscriptFixture(async ({ request, transcriptBefore, hooks }) => {
        const observed: { rewriteRejected?: boolean } = {};
        contextEngineCompactMock.mockResolvedValueOnce(completed(sessionId));
        maintain.mockImplementationOnce(async ({ runtimeContext }) => {
          const rewrite = runtimeContext?.rewriteTranscriptEntries;
          if (!rewrite) {
            throw new Error("expected an active maintenance rewrite capability");
          }
          const replaceWriter = () => {
            replaceSessionEntrySync(target(), {
              ...owner,
              updatedAt: 2,
              activeWriterRunId: "replacement-writer",
            });
          };
          if (replacementPoint === "before rewrite") {
            replaceWriter();
          } else {
            hooks.beforeBranchRead = () => {
              hooks.beforeBranchRead = undefined;
              replaceWriter();
            };
          }
          observed.rewriteRejected = await rewrite(request).then(
            () => false,
            () => true,
          );
          return { changed: false, bytesFreed: 0, rewrittenEntries: 0 };
        });

        // The caller can validate its logical session without knowing the queued
        // operation's exact writer; that fence belongs to the queued owner.
        await compact(
          { ...compactParams(), sessionEntry: capturedEntry },
          {
            assertActive: () => {
              const current = loadSessionEntry(target());
              if (
                current?.sessionId !== owner.sessionId ||
                current.lifecycleRevision !== owner.lifecycleRevision
              ) {
                throw new Error("caller session changed");
              }
            },
          },
        ).catch(() => undefined);

        expect(observed.rewriteRejected).toBe(true);
        expect(loadSessionEntry(target())).toMatchObject({
          ...owner,
          activeWriterRunId: "replacement-writer",
        });
        expect(loadTranscriptEventsSync(target())).toEqual(transcriptBefore);
      });
    },
  );

  it("preserves completed compaction when cancellation interrupts maintenance", async () => {
    const controller = new AbortController();
    maintain.mockImplementationOnce(async () => {
      controller.abort(new Error("cancel during maintenance"));
      return { changed: false, bytesFreed: 0, rewrittenEntries: 0 };
    });

    await expect(compact(compactParams(controller.signal))).resolves.toMatchObject({
      ok: true,
      compacted: true,
      result: { sessionId: "successor", tokensAfter: 40 },
    });

    expect(hookRunner.runAfterCompaction).not.toHaveBeenCalled();
    expect(maybeCompactAgentHarnessSessionMock).not.toHaveBeenCalled();
  });
});
