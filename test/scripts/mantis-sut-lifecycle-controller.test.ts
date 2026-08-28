import fs from "node:fs";
import { describe, expect, it } from "vitest";
import {
  createMantisLifecycleState,
  isRootOwnedMantisLifecycleRuntime,
  transitionMantisLifecycle,
  type MantisLifecycleState,
  validateMantisLifecycleJournal,
} from "../../scripts/mantis/mantis-sut-lifecycle-controller.ts";

const AT = "2026-08-22T12:00:00.000Z";
const CONTAINER_A = "a".repeat(64);
const CONTAINER_B = "b".repeat(64);
const MOCK_CONTAINER = "c".repeat(64);
const PROXY_CONTAINER = "d".repeat(64);
const REQUEST_A = "11111111-1111-4111-8111-111111111111";
const REQUEST_B = "22222222-2222-4222-8222-222222222222";

function runtimeStat(
  params: {
    directory?: boolean;
    mode?: number;
    symlink?: boolean;
    uid?: number;
  } = {},
) {
  return {
    isDirectory: () => params.directory ?? true,
    isSymbolicLink: () => params.symlink ?? false,
    mode: params.mode ?? 0o41_770,
    uid: params.uid ?? 0,
  };
}

function readyInitialState(): MantisLifecycleState {
  let state = createMantisLifecycleState(AT).state;
  state = transitionMantisLifecycle(
    state,
    {
      mockContainerId: MOCK_CONTAINER,
      proxyContainerId: PROXY_CONTAINER,
      type: "sidecars",
    },
    AT,
  ).state;
  state = transitionMantisLifecycle(
    state,
    { containerId: CONTAINER_A, generation: 1, type: "started" },
    AT,
  ).state;
  return transitionMantisLifecycle(
    state,
    { containerId: CONTAINER_A, generation: 1, type: "ready" },
    AT,
  ).state;
}

function requestRestart(
  state: MantisLifecycleState,
  mode: "crash" | "graceful",
  requestId = REQUEST_A,
): MantisLifecycleState {
  return transitionMantisLifecycle(
    state,
    {
      expectedGeneration: state.generation,
      mode,
      readinessTimeoutSeconds: 60,
      requestId,
      type: "request",
    },
    AT,
  ).state;
}

describe("Mantis lifecycle generation state", () => {
  it("matches the wrapper's exact locked-runtime permission contract", () => {
    const wrapper = fs.readFileSync("scripts/mantis/mantis-sut-container.sh", "utf8");
    const producer = wrapper.slice(
      wrapper.indexOf("lock_runtime_root()"),
      wrapper.indexOf("locked_runtime_root()"),
    );
    const consumer = wrapper.slice(
      wrapper.indexOf("locked_runtime_root()"),
      wrapper.indexOf("create_lifecycle_lock()"),
    );

    expect(producer).toContain('chmod 1770 "$safe_runtime"');
    expect(consumer).toContain('== "1770"');
    expect(isRootOwnedMantisLifecycleRuntime(runtimeStat())).toBe(true);
    expect(isRootOwnedMantisLifecycleRuntime(runtimeStat({ mode: 0o40_770 }))).toBe(false);
    expect(isRootOwnedMantisLifecycleRuntime(runtimeStat({ mode: 0o41_755 }))).toBe(false);
    expect(isRootOwnedMantisLifecycleRuntime(runtimeStat({ uid: 1 }))).toBe(false);
    expect(isRootOwnedMantisLifecycleRuntime(runtimeStat({ directory: false }))).toBe(false);
    expect(isRootOwnedMantisLifecycleRuntime(runtimeStat({ symlink: true }))).toBe(false);
  });

  it("binds a requested restart to a distinct ready successor", () => {
    let state = requestRestart(readyInitialState(), "graceful");
    const exited = transitionMantisLifecycle(
      state,
      { containerId: CONTAINER_A, exitCode: 0, generation: 1, type: "exited" },
      AT,
    );
    expect(exited.events).toMatchObject([
      {
        event: "gateway_exited",
        expected: true,
        generation: 1,
        mode: "graceful",
        termination: "graceful",
      },
      { event: "gateway_starting", generation: 2, requestId: REQUEST_A },
    ]);
    state = exited.state;
    expect(() =>
      transitionMantisLifecycle(
        state,
        { containerId: CONTAINER_A, generation: 2, type: "started" },
        AT,
      ),
    ).toThrow("reused the previous container identity");
    state = transitionMantisLifecycle(
      state,
      { containerId: CONTAINER_B, generation: 2, type: "started" },
      AT,
    ).state;
    const ready = transitionMantisLifecycle(
      state,
      { containerId: CONTAINER_B, generation: 2, type: "ready" },
      AT,
    );
    expect(ready.state).toMatchObject({
      causedByRequestId: REQUEST_A,
      containerId: CONTAINER_B,
      generation: 2,
      phase: "ready",
      sequence: 9,
    });
    expect(ready.state).not.toHaveProperty("previousContainerId");
  });

  it("records crash and graceful escalation as forced termination", () => {
    for (const mode of ["crash", "graceful"] as const) {
      const state = requestRestart(readyInitialState(), mode);
      const result = transitionMantisLifecycle(
        state,
        { containerId: CONTAINER_A, exitCode: 137, generation: 1, type: "exited" },
        AT,
      );
      expect(result.events[0]).toMatchObject({
        event: "gateway_exited",
        expected: true,
        mode,
        termination: "forced",
      });
    }
  });

  it("rejects stale, duplicate, and mismatched lifecycle actions", () => {
    const ready = readyInitialState();
    expect(() =>
      transitionMantisLifecycle(
        ready,
        {
          expectedGeneration: 2,
          mode: "crash",
          readinessTimeoutSeconds: 60,
          requestId: REQUEST_A,
          type: "request",
        },
        AT,
      ),
    ).toThrow("stale lifecycle generation");
    const requested = requestRestart(ready, "crash");
    expect(() => requestRestart(requested, "crash", REQUEST_B)).toThrow(
      "requires a ready generation",
    );
    expect(() =>
      transitionMantisLifecycle(requested, { requestId: REQUEST_B, type: "request-failed" }, AT),
    ).toThrow("does not match the active request");
    expect(() =>
      transitionMantisLifecycle(
        requested,
        { containerId: CONTAINER_B, exitCode: 137, generation: 1, type: "exited" },
        AT,
      ),
    ).toThrow("container identity does not match");
  });

  it("preserves the exact 5 and 120 second readiness boundaries on the active request", () => {
    for (const readinessTimeoutSeconds of [5, 120]) {
      const requested = transitionMantisLifecycle(
        readyInitialState(),
        {
          expectedGeneration: 1,
          mode: "crash",
          readinessTimeoutSeconds,
          requestId: REQUEST_A,
          type: "request",
        },
        AT,
      );
      expect(requested.state.activeRequest?.readinessTimeoutSeconds).toBe(readinessTimeoutSeconds);
    }
    for (const readinessTimeoutSeconds of [4, 121]) {
      expect(() =>
        transitionMantisLifecycle(
          readyInitialState(),
          {
            expectedGeneration: 1,
            mode: "crash",
            readinessTimeoutSeconds,
            requestId: REQUEST_A,
            type: "request",
          },
          AT,
        ),
      ).toThrow();
    }
  });

  it("restores the same ready generation when the Docker action never fired", () => {
    const requested = requestRestart(readyInitialState(), "graceful");
    const restored = transitionMantisLifecycle(
      requested,
      { requestId: REQUEST_A, type: "request-failed" },
      AT,
    );
    expect(restored.state).toMatchObject({
      containerId: CONTAINER_A,
      generation: 1,
      phase: "ready",
    });
    expect(restored.state).not.toHaveProperty("activeRequest");
    expect(restored.events[0]).toMatchObject({
      event: "lifecycle_request_failed",
      requestId: REQUEST_A,
    });
  });

  it("fails closed on an unexpected Gateway exit", () => {
    const result = transitionMantisLifecycle(
      readyInitialState(),
      { containerId: CONTAINER_A, exitCode: 1, generation: 1, type: "exited" },
      AT,
    );
    expect(result.state.phase).toBe("failed");
    expect(result.events).toMatchObject([
      { event: "gateway_exited", expected: false, generation: 1 },
    ]);
    expect(result.events[0]).not.toHaveProperty("requestId");
    const cleanupCancel = transitionMantisLifecycle(result.state, { type: "cancel" }, AT);
    expect(cleanupCancel.state).toEqual(result.state);
    expect(cleanupCancel.events).toEqual([]);
  });

  it("records a ready successor dependency loss as a terminal root fact", () => {
    const requested = requestRestart(readyInitialState(), "crash");
    const starting = transitionMantisLifecycle(
      requested,
      { containerId: CONTAINER_A, exitCode: 137, generation: 1, type: "exited" },
      AT,
    ).state;
    const started = transitionMantisLifecycle(
      starting,
      { containerId: CONTAINER_B, generation: 2, type: "started" },
      AT,
    ).state;
    const ready = transitionMantisLifecycle(
      started,
      { containerId: CONTAINER_B, generation: 2, type: "ready" },
      AT,
    ).state;
    const failed = transitionMantisLifecycle(
      ready,
      { dependency: "mock-openai", requestId: REQUEST_A, type: "dependency-failed" },
      AT,
    );
    expect(failed.state.phase).toBe("failed");
    expect(failed.events).toMatchObject([
      {
        containerId: CONTAINER_B,
        dependency: "mock-openai",
        event: "lifecycle_dependency_failed",
        requestId: REQUEST_A,
      },
    ]);
    expect(transitionMantisLifecycle(failed.state, { type: "cancel" }, AT)).toEqual({
      events: [],
      state: failed.state,
    });
  });

  it("cancels a pending replacement once and never starts a successor", () => {
    const requested = requestRestart(readyInitialState(), "crash");
    const cancelled = transitionMantisLifecycle(requested, { type: "cancel" }, AT);
    expect(cancelled.state).toMatchObject({ generation: 1, phase: "cancelled" });
    expect(cancelled.events).toMatchObject([
      { event: "runtime_cancelled", generation: 1, requestId: REQUEST_A },
    ]);
    const repeated = transitionMantisLifecycle(cancelled.state, { type: "cancel" }, AT);
    expect(repeated.events).toEqual([]);
    expect(repeated.state).toEqual(cancelled.state);
  });

  it("cancels cleanly before exit, during successor launch, and during readiness", () => {
    const requested = requestRestart(readyInitialState(), "crash");
    const starting = transitionMantisLifecycle(
      requested,
      { containerId: CONTAINER_A, exitCode: 137, generation: 1, type: "exited" },
      AT,
    ).state;
    const probing = transitionMantisLifecycle(
      starting,
      { containerId: CONTAINER_B, generation: 2, type: "started" },
      AT,
    ).state;
    for (const state of [requested, starting, probing]) {
      const cancelled = transitionMantisLifecycle(state, { type: "cancel" }, AT);
      expect(cancelled.state.phase).toBe("cancelled");
      expect(cancelled.state.generation).toBe(state.generation);
      expect(cancelled.events).toHaveLength(1);
      expect(cancelled.events[0]).toMatchObject({ event: "runtime_cancelled" });
    }
    const cancelledDuringReadiness = transitionMantisLifecycle(
      probing,
      { type: "cancel" },
      AT,
    ).state;
    expect(() =>
      transitionMantisLifecycle(
        cancelledDuringReadiness,
        { containerId: CONTAINER_B, generation: 2, type: "ready" },
        AT,
      ),
    ).toThrow("terminal lifecycle phase cancelled");
  });

  it("distinguishes launch failure from bound-container readiness failure", () => {
    const initial = transitionMantisLifecycle(
      createMantisLifecycleState(AT).state,
      {
        mockContainerId: MOCK_CONTAINER,
        proxyContainerId: PROXY_CONTAINER,
        type: "sidecars",
      },
      AT,
    ).state;
    const noContainer = transitionMantisLifecycle(
      initial,
      { generation: 1, type: "start-failed" },
      AT,
    );
    expect(noContainer.state.phase).toBe("failed");
    expect(noContainer.events[0]).toMatchObject({ event: "gateway_start_failed" });
    expect(noContainer.events[0]).not.toHaveProperty("containerId");

    const started = transitionMantisLifecycle(
      initial,
      { containerId: CONTAINER_A, generation: 1, type: "started" },
      AT,
    ).state;
    const bound = transitionMantisLifecycle(
      started,
      { containerId: CONTAINER_A, generation: 1, type: "readiness-failed" },
      AT,
    );
    expect(bound.state.phase).toBe("failed");
    expect(bound.events[0]).toMatchObject({ containerId: CONTAINER_A });
  });

  it("binds distinct sidecars once before the initial Gateway", () => {
    const initial = createMantisLifecycleState(AT).state;
    expect(() =>
      transitionMantisLifecycle(
        initial,
        {
          mockContainerId: MOCK_CONTAINER,
          proxyContainerId: MOCK_CONTAINER,
          type: "sidecars",
        },
        AT,
      ),
    ).toThrow("distinct container identities");
    const bound = transitionMantisLifecycle(
      initial,
      {
        mockContainerId: MOCK_CONTAINER,
        proxyContainerId: PROXY_CONTAINER,
        type: "sidecars",
      },
      AT,
    );
    expect(bound.state).toMatchObject({
      mockContainerId: MOCK_CONTAINER,
      proxyContainerId: PROXY_CONTAINER,
    });
    expect(() =>
      transitionMantisLifecycle(
        bound.state,
        {
          mockContainerId: MOCK_CONTAINER,
          proxyContainerId: PROXY_CONTAINER,
          type: "sidecars",
        },
        AT,
      ),
    ).toThrow("bound only once");
  });

  it("fails loudly before reusing a journal sequence after an interrupted write", () => {
    const initial = createMantisLifecycleState(AT);
    const evidence = `${initial.events.map((event) => JSON.stringify(event)).join("\n")}\n`;
    expect(() => validateMantisLifecycleJournal(initial.state, evidence)).not.toThrow();
    expect(() =>
      validateMantisLifecycleJournal({ ...initial.state, sequence: 2 }, evidence),
    ).toThrow("state and evidence journal are inconsistent");
    expect(() => validateMantisLifecycleJournal(initial.state, `${evidence}${evidence}`)).toThrow(
      "state and evidence journal are inconsistent",
    );
    expect(() =>
      validateMantisLifecycleJournal({ ...initial.state, phase: "ready" }, evidence),
    ).toThrow("state and evidence journal are inconsistent");
  });
});
