import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";

const persistLifecycle = vi.hoisted(() => vi.fn());
const ownerStatus = vi.hoisted(() => vi.fn());

vi.mock("./session-lifecycle-state.js", () => ({
  persistGatewaySessionLifecycleEvent: persistLifecycle,
}));
vi.mock("../infra/agent-run-registry.js", () => ({
  getAgentRunContextOwnerStatus: ownerStatus,
}));

import { createSessionLifecyclePersistenceOwner } from "./session-lifecycle-persistence-owner.js";

type PersistenceParams = Parameters<
  typeof import("./session-lifecycle-state.js").persistGatewaySessionLifecycleEvent
>[0];

const terminal = {
  sessionKey: "agent:main:main",
  event: {
    runId: "run-1",
    seq: 2,
    stream: "lifecycle",
    lifecycleGeneration: "generation-1",
    sessionId: "session-1",
    ts: 2_000,
    data: { phase: "end", startedAt: 1_000, endedAt: 2_000 },
  },
};

describe("session lifecycle persistence owner", () => {
  beforeEach(() => {
    persistLifecycle.mockReset();
    ownerStatus.mockReset().mockReturnValue("active");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts one terminal write before the chat handler consumes it", async () => {
    persistLifecycle.mockResolvedValue(undefined);
    const owner = createSessionLifecyclePersistenceOwner();

    const prepared = owner.observe(terminal);
    const consumed = owner.persist(terminal);

    expect(consumed).toBe(prepared);
    expect(persistLifecycle).toHaveBeenCalledOnce();
    await consumed;
    await owner.drain();
  });

  it("distinguishes reused run ids by their exact owner claim", async () => {
    persistLifecycle.mockResolvedValue(undefined);
    const owner = createSessionLifecyclePersistenceOwner();
    const first = {
      ...terminal,
      event: { ...terminal.event, contextClaimId: "claim-1" },
    };
    const successor = {
      ...terminal,
      event: { ...terminal.event, contextClaimId: "claim-2" },
    };

    const firstPrepared = owner.observe(first);
    const successorPrepared = owner.observe(successor);

    expect(successorPrepared).not.toBe(firstPrepared);
    expect(persistLifecycle).toHaveBeenCalledTimes(2);
    expect(owner.persist(successor)).toBe(successorPrepared);
    await Promise.all([firstPrepared, successorPrepared]);
    await owner.drain();
  });

  it("preserves private restart-recovery metadata for the durable write", async () => {
    persistLifecycle.mockResolvedValue(undefined);
    const event = {
      runId: "run-recovery",
      seq: 2,
      stream: "lifecycle",
      sessionId: "session-recovery",
      ts: 2_000,
      data: { phase: "end", startedAt: 1_000, endedAt: 2_000 },
    } as typeof terminal.event & { mainSessionRestartRecovery?: true };
    Object.defineProperties(event, {
      lifecycleGeneration: { value: "generation-recovery", enumerable: false },
      mainSessionRestartRecovery: { value: true, enumerable: false },
    });
    const owner = createSessionLifecyclePersistenceOwner();

    await owner.observe({ sessionKey: terminal.sessionKey, event });

    expect(persistLifecycle).toHaveBeenCalledWith({
      sessionKey: terminal.sessionKey,
      event: expect.objectContaining({
        lifecycleGeneration: "generation-recovery",
        mainSessionRestartRecovery: true,
      }),
    });
    await owner.drain();
  });

  it("persists a keyed error after the chat retry grace expires", async () => {
    persistLifecycle.mockResolvedValue(undefined);
    const owner = createSessionLifecyclePersistenceOwner();
    const error = {
      ...terminal,
      event: {
        ...terminal.event,
        data: { phase: "error", error: "fallback exhausted", endedAt: 2_000 },
      },
    };

    await owner.persist(error);

    expect(persistLifecycle).toHaveBeenCalledOnce();
    expect(persistLifecycle).toHaveBeenCalledWith(error);
  });

  it("keeps terminal writes alive until shutdown drains them", async () => {
    const deferred = createDeferred();
    persistLifecycle.mockReturnValue(deferred.promise);
    const owner = createSessionLifecyclePersistenceOwner();
    void owner.observe(terminal);

    let drained = false;
    const drain = owner.drain().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);

    deferred.resolve();
    await drain;
    expect(drained).toBe(true);
  });

  it("keeps a pending write available after its lookup grace expires", async () => {
    vi.useFakeTimers();
    const deferred = createDeferred();
    persistLifecycle.mockReturnValue(deferred.promise);
    const owner = createSessionLifecyclePersistenceOwner();
    const prepared = owner.observe(terminal);
    await vi.advanceTimersByTimeAsync(60_000);

    const consumed = owner.persist(terminal);

    expect(consumed).toBe(prepared);
    deferred.resolve();
    await consumed;
    await owner.drain();
  });

  it("keeps a prepared write available while shutdown drain waits", async () => {
    const deferred = createDeferred();
    persistLifecycle.mockReturnValue(deferred.promise);
    const owner = createSessionLifecyclePersistenceOwner();
    const prepared = owner.observe(terminal);
    const draining = owner.drain();
    await Promise.resolve();

    const consumed = owner.persist(terminal);

    expect(consumed).toBe(prepared);
    deferred.resolve();
    await Promise.all([consumed, draining]);
  });

  it("rejects a terminal write when its exact claim retires before commit", async () => {
    const beforeCommit = createDeferred();
    const commitReached = createDeferred();
    let sessionStatus = "running";
    persistLifecycle.mockImplementation(async (params: PersistenceParams) => {
      commitReached.resolve();
      await beforeCommit.promise;
      params.assertCommitAllowed?.();
      sessionStatus = "done";
    });
    const owner = createSessionLifecyclePersistenceOwner();
    const persistence = owner.observe({
      ...terminal,
      authority: {
        claimId: "claim-1",
        lifecycleGeneration: "generation-1",
        runId: "run-1",
      },
    });
    await commitReached.promise;

    ownerStatus.mockReturnValue(undefined);
    beforeCommit.resolve();

    await expect(persistence).rejects.toMatchObject({
      name: "AbortError",
      code: "ERR_STALE_GATEWAY_LIFECYCLE",
    });
    expect(sessionStatus).toBe("running");
  });

  it("rejects a deferred error when its exact claim retires before commit", async () => {
    const beforeCommit = createDeferred();
    const commitReached = createDeferred();
    let sessionStatus = "running";
    persistLifecycle.mockImplementation(async (params: PersistenceParams) => {
      commitReached.resolve();
      await beforeCommit.promise;
      params.assertCommitAllowed?.();
      sessionStatus = "failed";
    });
    const owner = createSessionLifecyclePersistenceOwner();
    const persistence = owner.persist({
      ...terminal,
      event: {
        ...terminal.event,
        contextClaimId: "claim-error",
        data: { phase: "error", error: "fallback exhausted", endedAt: 2_000 },
      },
    });
    await commitReached.promise;

    ownerStatus.mockReturnValue(undefined);
    beforeCommit.resolve();

    await expect(persistence).rejects.toMatchObject({
      name: "AbortError",
      code: "ERR_STALE_GATEWAY_LIFECYCLE",
    });
    expect(sessionStatus).toBe("running");
  });

  it.each([
    { name: "end", data: { phase: "end" } },
    { name: "native cancellation", data: { phase: "error", aborted: true, stopReason: "aborted" } },
    { name: "fallback exhaustion", data: { phase: "error", fallbackExhaustedFailure: true } },
    { name: "settled execution failure", data: { phase: "error", executionSettled: true } },
  ])("does not restart $name after its prepared promise expires", async ({ data }) => {
    vi.useFakeTimers();
    persistLifecycle.mockResolvedValue(undefined);
    const owner = createSessionLifecyclePersistenceOwner();
    const event = { ...terminal, event: { ...terminal.event, data } };
    await owner.observe(event);
    await vi.advanceTimersByTimeAsync(60_000);

    await expect(owner.persist(event)).rejects.toMatchObject({
      code: "ERR_STALE_GATEWAY_LIFECYCLE",
    });
    expect(persistLifecycle).toHaveBeenCalledOnce();
  });
});
