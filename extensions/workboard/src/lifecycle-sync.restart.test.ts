import { describe, expect, it, vi } from "vitest";
import { dispatchAndStartWorkboardCards } from "./dispatcher.js";
import { createWorkboardLifecycleService, syncWorkboardSubagentEnded } from "./lifecycle-sync.js";
import type { PersistedWorkboardCard, WorkboardKeyedStore } from "./persistence-types.js";
import { WorkboardStore } from "./store.js";

function createMemoryStore(): WorkboardKeyedStore {
  const entries = new Map<string, PersistedWorkboardCard>();
  return {
    async register(key, value) {
      entries.set(key, value);
    },
    async lookup(key) {
      return entries.get(key);
    },
    async delete(key) {
      return entries.delete(key);
    },
    async entries() {
      return [...entries].map(([key, value]) => ({ key, value }));
    },
  };
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function beginPreparedDispatch() {
  const keyed = createMemoryStore();
  const dispatchStore = new WorkboardStore(keyed);
  const card = await dispatchStore.create({
    title: "Prepared across restart",
    status: "ready",
    workspaceAccess: { unrestricted: true },
  });
  const reachedRun = createDeferred<{ sessionKey: string; provisionalRunId: string }>();
  const runResult = createDeferred<{ sessionKey?: string; runId: string }>();
  const run = vi.fn().mockImplementation(async (input) => {
    reachedRun.resolve({
      sessionKey: input.sessionKey,
      provisionalRunId: input.idempotencyKey,
    });
    return await runResult.promise;
  });
  const dispatch = dispatchAndStartWorkboardCards({
    store: dispatchStore,
    subagent: { run },
    options: { maxStarts: 1 },
  });
  const prepared = await reachedRun.promise;
  return {
    card,
    dispatch,
    prepared,
    runResult,
    replacementStore: new WorkboardStore(keyed),
  };
}

async function rejectInterruptedDispatch(
  interrupted: Awaited<ReturnType<typeof beginPreparedDispatch>>,
) {
  interrupted.runResult.reject(new Error("simulated dispatcher process loss"));
  await interrupted.dispatch;
}

async function startLifecycleSweep(params: {
  store: WorkboardStore;
  sessions: Array<{
    key: string;
    updatedAt?: number;
    status?: "running" | "done" | "failed" | "killed" | "timeout";
    hasActiveRun?: boolean;
  }>;
  complete: boolean;
}) {
  const readSessions = vi.fn().mockResolvedValue({
    sessions: params.sessions,
    complete: params.complete,
  });
  const service = createWorkboardLifecycleService({ store: params.store, readSessions });
  const context = { logger: { warn: vi.fn() } } as never;
  await service.start(context);
  return { context, readSessions, service };
}

async function stopLifecycleSweep(
  lifecycle: Awaited<ReturnType<typeof startLifecycleSweep>>,
): Promise<void> {
  lifecycle.service.onGatewayStop();
  await lifecycle.service.stop?.(lifecycle.context);
}

describe("Workboard prepared launch restart recovery", () => {
  it("fails a prepared launch absent from the first complete post-restart snapshot", async () => {
    const interrupted = await beginPreparedDispatch();
    const lifecycle = await startLifecycleSweep({
      store: interrupted.replacementStore,
      sessions: [],
      complete: true,
    });

    await expect(interrupted.replacementStore.get(interrupted.card.id)).resolves.toMatchObject({
      status: "running",
      sessionKey: interrupted.prepared.sessionKey,
      runId: interrupted.prepared.provisionalRunId,
      execution: { status: "running", runId: interrupted.prepared.provisionalRunId },
      metadata: {
        claim: { ownerId: "workboard-dispatcher" },
        attempts: [{ status: "running", runId: interrupted.prepared.provisionalRunId }],
        automation: { launch: { phase: "prepared" } },
      },
    });
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(lifecycle.readSessions).not.toHaveBeenCalled();

    lifecycle.service.onGatewayStart();
    await vi.waitFor(async () => {
      expect((await interrupted.replacementStore.get(interrupted.card.id))?.status).toBe("blocked");
    });
    await stopLifecycleSweep(lifecycle);

    const recovered = await interrupted.replacementStore.get(interrupted.card.id);
    expect(recovered).toMatchObject({
      status: "blocked",
      metadata: {
        automation: {
          launch: {
            phase: "failed",
            requestedSessionKey: interrupted.prepared.sessionKey,
            provisionalRunId: interrupted.prepared.provisionalRunId,
            reason: expect.stringContaining("Gateway"),
          },
        },
        attempts: [
          expect.objectContaining({
            status: "blocked",
            runId: interrupted.prepared.provisionalRunId,
            endedAt: expect.any(Number),
          }),
        ],
      },
    });
    expect(recovered?.metadata?.claim).toBeUndefined();
    expect(recovered?.sessionKey).toBeUndefined();
    expect(recovered?.runId).toBeUndefined();
    expect(recovered?.execution).toBeUndefined();

    await rejectInterruptedDispatch(interrupted);
    expect(
      (await interrupted.replacementStore.get(interrupted.card.id))?.metadata?.automation?.launch,
    ).toMatchObject({ phase: "failed" });
  });

  it("fails a prepared launch when its persisted session has no active run", async () => {
    const interrupted = await beginPreparedDispatch();
    const lifecycle = await startLifecycleSweep({
      store: interrupted.replacementStore,
      sessions: [
        {
          key: `agent:worker:${interrupted.prepared.sessionKey}`,
          status: "running",
          hasActiveRun: false,
        },
      ],
      complete: true,
    });

    lifecycle.service.onGatewayStart();
    await vi.waitFor(async () => {
      expect((await interrupted.replacementStore.get(interrupted.card.id))?.status).toBe("blocked");
    });
    await stopLifecycleSweep(lifecycle);

    await expect(interrupted.replacementStore.get(interrupted.card.id)).resolves.toMatchObject({
      status: "blocked",
      metadata: { automation: { launch: { phase: "failed" } } },
    });
    expect(
      (await interrupted.replacementStore.get(interrupted.card.id))?.metadata?.claim,
    ).toBeUndefined();
    await rejectInterruptedDispatch(interrupted);
  });

  it("accepts a prepared launch found under its canonical post-restart session", async () => {
    const interrupted = await beginPreparedDispatch();
    const canonicalSessionKey = `agent:worker:${interrupted.prepared.sessionKey}`;
    const lifecycle = await startLifecycleSweep({
      store: interrupted.replacementStore,
      sessions: [{ key: canonicalSessionKey, status: "running", hasActiveRun: true }],
      complete: true,
    });

    expect(lifecycle.readSessions).not.toHaveBeenCalled();
    lifecycle.service.onGatewayStart();
    await vi.waitFor(async () => {
      expect(
        (await interrupted.replacementStore.get(interrupted.card.id))?.metadata?.automation?.launch
          ?.phase,
      ).toBe("accepted");
    });

    const accepted = await interrupted.replacementStore.get(interrupted.card.id);
    expect(accepted).toMatchObject({
      status: "running",
      sessionKey: canonicalSessionKey,
      runId: interrupted.prepared.provisionalRunId,
      metadata: {
        claim: { ownerId: "workboard-dispatcher" },
        attempts: [
          expect.objectContaining({
            status: "running",
            sessionKey: canonicalSessionKey,
            runId: interrupted.prepared.provisionalRunId,
          }),
        ],
        automation: {
          launch: {
            phase: "accepted",
            acceptedSessionKey: canonicalSessionKey,
          },
        },
      },
    });
    expect(accepted?.metadata?.automation?.launch).not.toHaveProperty("acceptedRunId");

    await syncWorkboardSubagentEnded({
      store: interrupted.replacementStore,
      event: {
        targetSessionKey: canonicalSessionKey,
        runId: "accepted-run",
        outcome: "ok",
      },
    });
    const terminal = await interrupted.replacementStore.get(interrupted.card.id);
    expect(terminal).toMatchObject({
      status: "review",
      sessionKey: canonicalSessionKey,
      runId: "accepted-run",
      metadata: {
        automation: { launch: { phase: "accepted", acceptedRunId: "accepted-run" } },
        attempts: [
          expect.objectContaining({
            id: "accepted-run",
            status: "succeeded",
            runId: "accepted-run",
          }),
        ],
      },
    });
    expect(terminal?.metadata?.attempts).toHaveLength(1);

    await stopLifecycleSweep(lifecycle);
    await rejectInterruptedDispatch(interrupted);
    expect((await interrupted.replacementStore.get(interrupted.card.id))?.status).toBe("review");
  });

  it("accepts a prepared launch from an explicit terminal session snapshot", async () => {
    const interrupted = await beginPreparedDispatch();
    const canonicalSessionKey = `agent:worker:${interrupted.prepared.sessionKey}`;
    const launch = (await interrupted.replacementStore.get(interrupted.card.id))?.metadata
      ?.automation?.launch;
    if (launch?.phase !== "prepared") {
      throw new Error("expected prepared launch");
    }
    const lifecycle = await startLifecycleSweep({
      store: interrupted.replacementStore,
      sessions: [
        {
          key: canonicalSessionKey,
          status: "done",
          hasActiveRun: false,
          updatedAt: launch.preparedAt + 1,
        },
      ],
      complete: true,
    });

    lifecycle.service.onGatewayStart();
    await vi.waitFor(async () => {
      expect((await interrupted.replacementStore.get(interrupted.card.id))?.status).toBe("review");
    });
    await stopLifecycleSweep(lifecycle);

    await expect(interrupted.replacementStore.get(interrupted.card.id)).resolves.toMatchObject({
      status: "review",
      sessionKey: canonicalSessionKey,
      metadata: {
        automation: {
          launch: { phase: "accepted", acceptedSessionKey: canonicalSessionKey },
        },
        attempts: [expect.objectContaining({ status: "succeeded" })],
      },
    });
    await rejectInterruptedDispatch(interrupted);
  });

  it("does not accept a terminal session without durable timing evidence", async () => {
    const interrupted = await beginPreparedDispatch();
    const canonicalSessionKey = `agent:worker:${interrupted.prepared.sessionKey}`;
    const lifecycle = await startLifecycleSweep({
      store: interrupted.replacementStore,
      sessions: [
        {
          key: canonicalSessionKey,
          status: "done",
          hasActiveRun: false,
        },
      ],
      complete: true,
    });

    lifecycle.service.onGatewayStart();
    await vi.waitFor(async () => {
      expect((await interrupted.replacementStore.get(interrupted.card.id))?.status).toBe("blocked");
    });
    await stopLifecycleSweep(lifecycle);

    await expect(interrupted.replacementStore.get(interrupted.card.id)).resolves.toMatchObject({
      status: "blocked",
      metadata: { automation: { launch: { phase: "failed" } } },
    });
    await rejectInterruptedDispatch(interrupted);
  });

  it("keeps a prepared launch running when the post-restart snapshot is incomplete", async () => {
    const interrupted = await beginPreparedDispatch();
    const lifecycle = await startLifecycleSweep({
      store: interrupted.replacementStore,
      sessions: [],
      complete: false,
    });

    lifecycle.service.onGatewayStart();
    await vi.waitFor(() => expect(lifecycle.readSessions).toHaveBeenCalledOnce());
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    await expect(interrupted.replacementStore.get(interrupted.card.id)).resolves.toMatchObject({
      status: "running",
      sessionKey: interrupted.prepared.sessionKey,
      runId: interrupted.prepared.provisionalRunId,
      metadata: {
        claim: { ownerId: "workboard-dispatcher" },
        automation: { launch: { phase: "prepared" } },
      },
    });

    await stopLifecycleSweep(lifecycle);
    await rejectInterruptedDispatch(interrupted);
  });
});
