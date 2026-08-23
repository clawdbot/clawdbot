// Persistent cron session tests cover lifecycle admission and mutation races.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { SessionEntry } from "../../config/sessions.js";
import * as diagnostic from "../../logging/diagnostic.js";
import {
  interruptSessionWorkAdmissions,
  isSessionWorkAdmissionActive,
  runExclusiveSessionLifecycleMutation,
} from "../../sessions/session-lifecycle-admission.js";
import { makeIsolatedAgentJobFixture, makeIsolatedAgentParamsFixture } from "./job-fixtures.js";
import {
  dispatchCronDeliveryMock,
  loadRunCronIsolatedAgentTurn,
  loadSessionEntryMock,
  callGatewayMock,
  makeCronSession,
  makeCronSessionEntry,
  mockRunCronFallbackPassthrough,
  patchSessionEntryMock,
  preflightCronModelProviderMock,
  resetRunCronIsolatedAgentTurnHarness,
  resolveCronSessionMock,
  runEmbeddedAgentMock,
} from "./run.test-harness.js";

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();
const inMemoryStorePath = "/tmp/store.json";

function makePersistentCronParams(sessionKey: string) {
  return makeIsolatedAgentParamsFixture({
    agentId: "main",
    sessionKey,
    job: makeIsolatedAgentJobFixture({
      // Bind the run to the persistent session key so the run operates on it
      // directly; `current`/`isolated` targets derive a detached `cron:<id>`
      // run session instead, which the lifecycle claim assertions do not target.
      sessionTarget: `session:${sessionKey}`,
      delivery: { mode: "none" },
    }),
  });
}

describe("runCronIsolatedAgentTurn session lifecycle", () => {
  beforeEach(() => {
    resetRunCronIsolatedAgentTurnHarness();
    mockRunCronFallbackPassthrough();
  });

  it("rejects a session that rotates before async setup", async () => {
    const sessionKey = "agent:main:main";
    const initialSessionEntry = makeCronSessionEntry({ sessionId: "session-before-setup" });
    resolveCronSessionMock.mockReturnValue(
      makeCronSession({
        storePath: inMemoryStorePath,
        store: { [sessionKey]: { ...initialSessionEntry } },
        initialSessionEntry,
        isNewSession: false,
        sessionEntry: { ...initialSessionEntry },
      }),
    );
    loadSessionEntryMock.mockReturnValue({
      ...initialSessionEntry,
      sessionId: "session-after-setup",
    });
    await expect(
      runCronIsolatedAgentTurn(makePersistentCronParams(sessionKey)),
    ).resolves.toMatchObject({
      status: "error",
      error: `Session "${sessionKey}" changed while starting work. Retry.`,
      admissionDisposition: "session-conflict",
    });
    expect(preflightCronModelProviderMock).not.toHaveBeenCalled();
    expect(runEmbeddedAgentMock).not.toHaveBeenCalled();
  });

  it("allows a rename and unpin during async setup", async () => {
    const sessionKey = "agent:main:main";
    const initialSessionEntry = makeCronSessionEntry({
      label: "before setup",
      pinnedAt: 1,
      sessionId: "same-session",
      updatedAt: 1,
    });
    const currentSessionEntry = {
      ...initialSessionEntry,
      label: "patched during setup",
      pinnedAt: undefined,
      updatedAt: 2,
    };
    resolveCronSessionMock.mockReturnValue(
      makeCronSession({
        storePath: inMemoryStorePath,
        store: { [sessionKey]: { ...currentSessionEntry } },
        initialSessionEntry,
        isNewSession: false,
        sessionEntry: { ...initialSessionEntry },
      }),
    );
    loadSessionEntryMock.mockReturnValue(currentSessionEntry);
    const releasePreflight = createDeferred();
    preflightCronModelProviderMock.mockImplementationOnce(async () => {
      await releasePreflight.promise;
      return { status: "available" };
    });

    const run = runCronIsolatedAgentTurn(makePersistentCronParams(sessionKey));
    await vi.waitFor(() => expect(preflightCronModelProviderMock).toHaveBeenCalledTimes(1));
    releasePreflight.resolve();

    await expect(run).resolves.toMatchObject({ status: "ok" });
    expect(runEmbeddedAgentMock).toHaveBeenCalledTimes(1);
  });

  it("protects the isolated cron session throughout async model preparation", async () => {
    const sessionKey = "agent:main:cron:test-job";
    const initialSessionEntry = makeCronSessionEntry({
      lifecycleRevision: "initial-revision",
      sessionId: "previous-session",
    });
    const sessionEntry = makeCronSessionEntry({ sessionId: "isolated-session" });
    resolveCronSessionMock.mockReturnValue(
      makeCronSession({
        storePath: inMemoryStorePath,
        store: { [sessionKey]: { ...initialSessionEntry } },
        initialSessionEntry,
        isNewSession: true,
        sessionEntry,
      }),
    );
    loadSessionEntryMock.mockImplementation((_storePath, currentSessionKey) =>
      currentSessionKey === sessionKey ? initialSessionEntry : undefined,
    );
    const releasePreflight = createDeferred();
    preflightCronModelProviderMock.mockImplementationOnce(async () => {
      await releasePreflight.promise;
      return { status: "available" };
    });

    const run = runCronIsolatedAgentTurn(
      makeIsolatedAgentParamsFixture({
        agentId: "main",
        sessionKey: "cron:test-job",
        job: makeIsolatedAgentJobFixture({
          sessionTarget: "isolated",
          delivery: { mode: "none" },
        }),
      }),
    );
    await vi.waitFor(() => expect(preflightCronModelProviderMock).toHaveBeenCalledTimes(1));
    const sessionIsProtectedDuringPreflight = isSessionWorkAdmissionActive(inMemoryStorePath, [
      sessionKey,
      "previous-session",
      "isolated-session",
    ]);
    releasePreflight.resolve();

    expect(sessionIsProtectedDuringPreflight).toBe(true);
    await expect(run).resolves.toMatchObject({ status: "ok" });
    expect(runEmbeddedAgentMock).toHaveBeenCalledTimes(1);
    expect(patchSessionEntryMock).toHaveBeenCalledWith(
      expect.objectContaining({ sessionKey }),
      expect.any(Function),
      expect.objectContaining({
        fallbackEntry: expect.objectContaining({ sessionId: "isolated-session" }),
      }),
    );
  });

  it("does not recreate a persistent session deleted during async setup", async () => {
    const sessionKey = "agent:main:main";
    const initialSessionEntry = makeCronSessionEntry({ sessionId: "persistent-session" });
    resolveCronSessionMock.mockReturnValue(
      makeCronSession({
        storePath: inMemoryStorePath,
        store: { [sessionKey]: { ...initialSessionEntry } },
        initialSessionEntry,
        isNewSession: false,
        sessionEntry: { ...initialSessionEntry },
      }),
    );
    loadSessionEntryMock.mockReturnValue(undefined);

    await expect(
      runCronIsolatedAgentTurn(makePersistentCronParams(sessionKey)),
    ).resolves.toMatchObject({
      status: "error",
      error: `Session "${sessionKey}" changed while starting work. Retry.`,
      admissionDisposition: "session-conflict",
    });
    expect(runEmbeddedAgentMock).not.toHaveBeenCalled();
  });

  it("interrupts persistent cron work and waits for its lifecycle lease to release", async () => {
    const sessionKey = "agent:main:telegram:direct:42";
    const sessionId = "shared-session";
    const storePath = inMemoryStorePath;
    const initialSessionEntry = makeCronSessionEntry({ sessionId });
    resolveCronSessionMock.mockReturnValue(
      makeCronSession({
        storePath,
        store: { [sessionKey]: { ...initialSessionEntry } },
        initialSessionEntry,
        isNewSession: false,
        sessionEntry: { ...initialSessionEntry },
      }),
    );
    loadSessionEntryMock.mockReturnValue({ ...initialSessionEntry });
    const runnerStarted = createDeferred();
    const lifecycleInterrupted = createDeferred();
    const releaseRunner = createDeferred();
    runEmbeddedAgentMock.mockImplementationOnce(
      async ({ abortSignal }: { abortSignal?: AbortSignal }) => {
        runnerStarted.resolve();
        if (abortSignal?.aborted) {
          lifecycleInterrupted.resolve();
        } else {
          abortSignal?.addEventListener("abort", () => lifecycleInterrupted.resolve(), {
            once: true,
          });
        }
        await releaseRunner.promise;
        return {
          payloads: [],
          meta: { aborted: true, agentMeta: {} },
        };
      },
    );

    const run = runCronIsolatedAgentTurn(makePersistentCronParams(sessionKey));
    await runnerStarted.promise;
    let mutationCommitted = false;
    const mutation = runExclusiveSessionLifecycleMutation({
      scope: storePath,
      identities: [sessionKey, sessionId],
      prepare: async () => {
        await interruptSessionWorkAdmissions({
          scope: storePath,
          identities: [sessionKey, sessionId],
        });
      },
      run: async () => {
        mutationCommitted = true;
      },
    });

    await lifecycleInterrupted.promise;
    expect(mutationCommitted).toBe(false);
    releaseRunner.resolve();

    const [result] = await Promise.all([run, mutation]);
    expect(result).toEqual(
      expect.objectContaining({
        status: "error",
        error: "agent run aborted for restart | OPENCLAW_RESTART_ABORT",
      }),
    );
    expect(mutationCommitted).toBe(true);
  });

  it("releases admission when final lifecycle marking fails", async () => {
    const sessionKey = "agent:main:cron:final-lifecycle-failure";
    const sessionId = "final-lifecycle-session";
    const initialSessionEntry = makeCronSessionEntry({ sessionId });
    resolveCronSessionMock.mockReturnValue(
      makeCronSession({
        storePath: inMemoryStorePath,
        store: { [sessionKey]: { ...initialSessionEntry } },
        initialSessionEntry,
        isNewSession: false,
        sessionEntry: { ...initialSessionEntry },
      }),
    );
    loadSessionEntryMock.mockReturnValue({ ...initialSessionEntry });
    const originalLogSessionStateChange = diagnostic.logSessionStateChange;
    const logSessionStateChangeSpy = vi
      .spyOn(diagnostic, "logSessionStateChange")
      .mockImplementation((params) => {
        if (params.state === "idle") {
          throw new Error("simulated final lifecycle failure");
        }
        return originalLogSessionStateChange(params);
      });

    try {
      await expect(runCronIsolatedAgentTurn(makePersistentCronParams(sessionKey))).rejects.toThrow(
        "simulated final lifecycle failure",
      );
      expect(isSessionWorkAdmissionActive(inMemoryStorePath, [sessionKey, sessionId])).toBe(false);
    } finally {
      logSessionStateChangeSpy.mockRestore();
    }
  });

  it("releases an isolated run lease before delete-after-run cleanup", async () => {
    const sessionKey = "agent:main:cron:test-job";
    const sessionId = "isolated-session";
    const storePath = inMemoryStorePath;
    resolveCronSessionMock.mockReturnValue(
      makeCronSession({
        storePath,
        initialSessionEntry: undefined,
        isNewSession: true,
        sessionEntry: makeCronSessionEntry({ sessionId }),
      }),
    );
    loadSessionEntryMock.mockReturnValue(undefined);
    let admissionActiveDuringDelete = true;
    callGatewayMock.mockImplementationOnce(async () => {
      admissionActiveDuringDelete = isSessionWorkAdmissionActive(storePath, [
        sessionKey,
        sessionId,
      ]);
      return { ok: true, deleted: true };
    });

    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentParamsFixture({
        agentId: "main",
        sessionKey: "cron:test-job",
        job: makeIsolatedAgentJobFixture({
          sessionTarget: "isolated",
          deleteAfterRun: true,
          delivery: { mode: "none" },
        }),
      }),
    );

    expect(result.status).toBe("ok");
    expect(callGatewayMock).toHaveBeenCalledTimes(1);
    expect(admissionActiveDuringDelete).toBe(false);
  });

  it("keeps a non-deleting isolated run admitted through delivery", async () => {
    const sessionKey = "agent:main:cron:test-job";
    const sessionId = "isolated-session";
    const storePath = inMemoryStorePath;
    resolveCronSessionMock.mockReturnValue(
      makeCronSession({
        storePath,
        initialSessionEntry: undefined,
        isNewSession: true,
        sessionEntry: makeCronSessionEntry({ sessionId }),
      }),
    );
    loadSessionEntryMock.mockReturnValue(undefined);
    const deliveryStarted = createDeferred();
    const releaseDelivery = createDeferred();
    dispatchCronDeliveryMock.mockImplementationOnce(async ({ deliveryPayloads }) => {
      deliveryStarted.resolve();
      await releaseDelivery.promise;
      return {
        delivered: false,
        deliveryAttempted: false,
        deliveryPayloads,
      };
    });

    const run = runCronIsolatedAgentTurn(
      makeIsolatedAgentParamsFixture({
        agentId: "main",
        sessionKey: "cron:test-job",
        job: makeIsolatedAgentJobFixture({
          sessionTarget: "isolated",
          deleteAfterRun: false,
          delivery: { mode: "none" },
        }),
      }),
    );
    await deliveryStarted.promise;
    expect(isSessionWorkAdmissionActive(storePath, [sessionKey, sessionId])).toBe(true);
    releaseDelivery.resolve();

    await expect(run).resolves.toMatchObject({ status: "ok" });
    expect(isSessionWorkAdmissionActive(storePath, [sessionKey, sessionId])).toBe(false);
  });

  it("marks a final lifecycle claim conflict as post-execution (#108428)", async () => {
    const sessionKey = "agent:main:main";
    const initialSessionEntry = makeCronSessionEntry({ sessionId: "persistent-session" });
    resolveCronSessionMock.mockReturnValue(
      makeCronSession({
        storePath: inMemoryStorePath,
        store: { [sessionKey]: { ...initialSessionEntry } },
        initialSessionEntry,
        isNewSession: false,
        sessionEntry: { ...initialSessionEntry },
      }),
    );
    loadSessionEntryMock.mockReturnValue({ ...initialSessionEntry });

    let agentExecutionStarted = false;
    runEmbeddedAgentMock.mockImplementationOnce(
      async (runParams: { onExecutionStarted?: () => void }) => {
        runParams.onExecutionStarted?.();
        agentExecutionStarted = true;
        return {
          payloads: [{ text: "completed" }],
          meta: { agentMeta: {} },
        };
      },
    );

    const committedRows = new Map<string, SessionEntry>([
      [`${inMemoryStorePath}\0${sessionKey}`, structuredClone(initialSessionEntry) as SessionEntry],
    ]);
    patchSessionEntryMock.mockImplementation(
      async (
        scope: { storePath?: string; sessionKey: string },
        update: (
          entry: SessionEntry,
          context: { existingEntry: SessionEntry | undefined },
        ) => SessionEntry | null,
        options: { fallbackEntry?: SessionEntry } = {},
      ) => {
        const key = `${scope.storePath ?? ""}\0${scope.sessionKey}`;
        const current = committedRows.get(key);
        const writeBase = current ?? options.fallbackEntry;
        if (!writeBase) {
          return null;
        }
        const existingEntry =
          agentExecutionStarted && scope.sessionKey === sessionKey
            ? { ...writeBase, lifecycleRevision: "replacement-revision" }
            : current;
        const committed = update(structuredClone(writeBase), {
          existingEntry: existingEntry ? structuredClone(existingEntry) : undefined,
        });
        if (committed) {
          committedRows.set(key, structuredClone(committed));
        }
        return committed;
      },
    );

    await expect(
      runCronIsolatedAgentTurn(makePersistentCronParams(sessionKey)),
    ).resolves.toMatchObject({
      status: "error",
      error: `Session "${sessionKey}" changed while starting work. Retry.`,
      executionStarted: true,
    });
  });

  it("releases a custom cron session lease before delete-after-run cleanup", async () => {
    const sessionKey = "agent:main:cron:cleanup";
    const sessionId = "custom-cron-session";
    const storePath = inMemoryStorePath;
    const initialSessionEntry = makeCronSessionEntry({ sessionId });
    resolveCronSessionMock.mockReturnValue(
      makeCronSession({
        storePath,
        store: { [sessionKey]: { ...initialSessionEntry } },
        initialSessionEntry,
        isNewSession: false,
        sessionEntry: { ...initialSessionEntry },
      }),
    );
    loadSessionEntryMock.mockReturnValue({ ...initialSessionEntry });
    let admissionActiveDuringDelete = true;
    callGatewayMock.mockImplementationOnce(async () => {
      admissionActiveDuringDelete = isSessionWorkAdmissionActive(storePath, [
        sessionKey,
        sessionId,
      ]);
      return { ok: true, deleted: true };
    });

    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentParamsFixture({
        agentId: "main",
        sessionKey,
        job: makeIsolatedAgentJobFixture({
          sessionTarget: `session:${sessionKey}`,
          deleteAfterRun: true,
          delivery: { mode: "none" },
        }),
      }),
    );

    expect(result.status).toBe("ok");
    expect(callGatewayMock).toHaveBeenCalledTimes(1);
    expect(admissionActiveDuringDelete).toBe(false);
  });
});
