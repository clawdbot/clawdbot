import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import {
  getAgentEventLifecycleGeneration,
  resetAgentEventsForTest,
  rotateAgentEventLifecycleGeneration,
} from "../../../infra/agent-events.js";
import { enqueueCommandInLane, getCommandLaneSnapshot } from "../../../process/command-queue.js";
import { resetCommandQueueStateForTest } from "../../../process/command-queue.test-support.js";
import { prepareSystemAgentRunAdmission } from "../../admitted-run-context.js";
import { isAgentRunDirectAbortReason } from "../../run-termination.js";
import { DEFAULT_AGENT_TIMEOUT_MS } from "../../timeout.js";
import { createEmbeddedRunLaneController } from "./lane-controller.js";
import { EMBEDDED_RUN_LANE_TIMEOUT_GRACE_MS } from "./lane-runtime.js";
import type { RunEmbeddedAgentParams } from "./params.js";

const GLOBAL_LANE = "attempt-controls-global";
const RUNTIME_TIMEOUT_MS = 120_000;
const cleanups: Array<() => void | Promise<void>> = [];
type LaneController = ReturnType<typeof createEmbeddedRunLaneController>;

async function createRunController(overrides: Partial<RunEmbeddedAgentParams> = {}) {
  let lifecycleGeneration = getAgentEventLifecycleGeneration();
  const runId = overrides.runId ?? "attempt-controls-run";
  const admission = prepareSystemAgentRunAdmission({}, runId, "main", "lane-controls-test");
  cleanups.push(admission.close);
  const admittedRunContext = await admission.admit("embedded");
  let params: RunEmbeddedAgentParams & { sessionFile: string } = {
    lifecycleGeneration,
    prompt: "queued run",
    runId,
    sessionFile: "/tmp/queued-run.jsonl",
    sessionId: "queued-session",
    timeoutMs: 1_000,
    workspaceDir: "/tmp",
    ...overrides,
    admittedRunContext,
  };
  const controller = createEmbeddedRunLaneController({
    getLifecycleGeneration: () => lifecycleGeneration,
    getParams: () => params,
    globalLane: GLOBAL_LANE,
    initialQueuedLifecycleGeneration: lifecycleGeneration,
    sessionLane: "attempt-controls-session",
    setLifecycleGeneration: (updated) => {
      lifecycleGeneration = updated;
    },
    setParams: (updated) => {
      params = updated;
    },
  });
  const createAttemptControls = (
    input: Omit<Parameters<LaneController["createAttemptControls"]>[0], "admittedRunContext"> = {},
  ) => {
    const controls = controller.createAttemptControls({ ...input, admittedRunContext });
    cleanups.push(controls.close);
    return controls;
  };
  return { controller, admission, createAttemptControls, runId };
}

async function holdLane(controller: LaneController) {
  const entered = createDeferred();
  const finished = createDeferred();
  const active = controller.enqueueGlobal(async () => {
    entered.resolve();
    await finished.promise;
    return { meta: { durationMs: 1 } };
  });
  const observed = active.catch((error: unknown) => error);
  cleanups.push(async () => {
    finished.resolve();
    await observed;
  });
  await entered.promise;
  return { observed, finish: finished.resolve };
}

beforeEach(() => {
  resetAgentEventsForTest();
  resetCommandQueueStateForTest();
  vi.useFakeTimers();
  vi.setSystemTime(Date.parse("2026-08-20T12:00:00Z"));
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    await cleanup();
  }
  resetAgentEventsForTest();
  resetCommandQueueStateForTest();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("runtime-owned lane deadline handoff", () => {
  test.each([
    { name: "seeded bounded", kind: "bounded", initialTimeoutMs: RUNTIME_TIMEOUT_MS },
    { name: "seeded unlimited", kind: "unlimited", initialTimeoutMs: MAX_TIMER_TIMEOUT_MS },
    { name: "runtime bounded", kind: "bounded", initialTimeoutMs: undefined },
    { name: "runtime unlimited", kind: "unlimited", initialTimeoutMs: undefined },
  ] as const)(
    "keeps $name execution behind its own deadline and cleanup grace",
    async ({ kind, initialTimeoutMs }) => {
      const { controller, createAttemptControls } = await createRunController();
      // Initial publication must survive until the real queue subscribes.
      const controls = createAttemptControls({ initialTimeoutMs });
      const { observed, finish } = await holdLane(controller);
      const next = vi.fn(async () => "next");
      const queued = enqueueCommandInLane(GLOBAL_LANE, next);
      if (initialTimeoutMs === undefined) {
        controls.onAttemptDeadlineChanged({ kind: "unlimited" });
        await vi.advanceTimersByTimeAsync(
          DEFAULT_AGENT_TIMEOUT_MS + EMBEDDED_RUN_LANE_TIMEOUT_GRACE_MS + 1,
        );
        if (kind === "bounded") {
          // Terminal receipt bounds settlement, even after unlimited execution.
          controls.onAttemptDeadlineChanged({
            kind,
            deadlineAtMs: Date.now() + RUNTIME_TIMEOUT_MS,
          });
        }
      }
      if (kind === "bounded") {
        await vi.advanceTimersByTimeAsync(
          RUNTIME_TIMEOUT_MS + EMBEDDED_RUN_LANE_TIMEOUT_GRACE_MS - 1,
        );
      } else {
        await vi.advanceTimersByTimeAsync(
          MAX_TIMER_TIMEOUT_MS + EMBEDDED_RUN_LANE_TIMEOUT_GRACE_MS + 1,
        );
      }
      expect(getCommandLaneSnapshot(GLOBAL_LANE)).toMatchObject({ activeCount: 1, queuedCount: 1 });
      expect(controls.abortSignal.aborted).toBe(false);
      expect(next).not.toHaveBeenCalled();
      if (kind === "bounded") {
        await vi.advanceTimersByTimeAsync(1);
        expect(controls.abortSignal.aborted).toBe(true);
        await expect(observed).resolves.toMatchObject({ name: "CommandLaneTaskTimeoutError" });
        expect(controls.abortSignal.reason).toBe(await observed);
      } else {
        finish();
        await expect(observed).resolves.toMatchObject({ meta: { durationMs: 1 } });
        expect(controls.abortSignal.aborted).toBe(false);
      }
      await expect(queued).resolves.toBe("next");
      expect(getCommandLaneSnapshot(GLOBAL_LANE).activeCount).toBe(0);
    },
  );

  test("restores idle recovery from actual completion only once when controls close", async () => {
    const { controller, createAttemptControls } = await createRunController();
    const controls = createAttemptControls({ initialTimeoutMs: MAX_TIMER_TIMEOUT_MS });
    const { observed } = await holdLane(controller);
    await vi.advanceTimersByTimeAsync(DEFAULT_AGENT_TIMEOUT_MS);
    controls.close();
    await vi.advanceTimersByTimeAsync(1_000 + EMBEDDED_RUN_LANE_TIMEOUT_GRACE_MS - 1);
    expect(getCommandLaneSnapshot(GLOBAL_LANE).activeCount).toBe(1);
    controls.close();
    await vi.advanceTimersByTimeAsync(1);
    expect(controller.abortSignal.aborted).toBe(true);
    await expect(observed).resolves.toMatchObject({
      name: "CommandLaneTaskTimeoutError",
      message: expect.stringContaining("no progress"),
    });
  });

  test("does not clear a maintenance deadline when controls never published one", async () => {
    const { controller, createAttemptControls } = await createRunController();
    controller.setLaneTaskDeadline({ kind: "unlimited" });
    const controls = createAttemptControls();
    const { observed, finish } = await holdLane(controller);
    controls.close();
    await vi.advanceTimersByTimeAsync(
      DEFAULT_AGENT_TIMEOUT_MS + EMBEDDED_RUN_LANE_TIMEOUT_GRACE_MS + 1,
    );
    expect(getCommandLaneSnapshot(GLOBAL_LANE).activeCount).toBe(1);
    expect(controller.abortSignal.aborted).toBe(false);
    finish();
    await expect(observed).resolves.toMatchObject({ meta: { durationMs: 1 } });
  });
});

describe("attempt control authority", () => {
  test.each([
    { invalidation: "closed", pendingTimeout: true },
    { invalidation: "superseded", pendingTimeout: true },
    { invalidation: "revoked", pendingTimeout: false },
    { invalidation: "replaced admission", pendingTimeout: false },
    { invalidation: "rotated lifecycle", pendingTimeout: true },
    { invalidation: "aborted input", pendingTimeout: false },
  ] as const)(
    "ignores retained controls after $invalidation",
    async ({ invalidation, pendingTimeout }) => {
      const { controller, admission, createAttemptControls, runId } = await createRunController();
      const inputAbort = new AbortController();
      const onAbort = vi.fn();
      const controls = createAttemptControls({
        initialTimeoutMs: RUNTIME_TIMEOUT_MS,
        abortSignal: inputAbort.signal,
        onAbort,
      });
      const { observed } = await holdLane(controller);
      if (pendingTimeout) {
        controls.onAttemptTimeout(new Error("old runtime timed out"));
      }
      switch (invalidation) {
        case "closed":
          controls.close();
          createAttemptControls({ initialTimeoutMs: RUNTIME_TIMEOUT_MS });
          break;
        case "superseded":
          createAttemptControls({ initialTimeoutMs: RUNTIME_TIMEOUT_MS });
          break;
        case "revoked":
          admission.close();
          break;
        case "replaced admission": {
          const replacement = prepareSystemAgentRunAdmission({}, runId, "main", "replacement-test");
          cleanups.push(replacement.close);
          await replacement.admit("embedded");
          break;
        }
        case "rotated lifecycle":
          rotateAgentEventLifecycleGeneration();
          break;
        case "aborted input":
          inputAbort.abort();
          break;
      }
      controls.onAttemptDeadlineChanged({ kind: "bounded", deadlineAtMs: Date.now() });
      controls.onAttemptTimeout(new Error("late runtime timeout"));
      controls.onAttemptAbort();
      await vi.advanceTimersByTimeAsync(EMBEDDED_RUN_LANE_TIMEOUT_GRACE_MS + 1);
      expect(onAbort).not.toHaveBeenCalled();
      expect(controller.abortSignal.aborted).toBe(false);
      expect(getCommandLaneSnapshot(GLOBAL_LANE).activeCount).toBe(1);

      controls.onAttemptDeadlineChanged({ kind: "unlimited" });
      if (invalidation === "closed" || invalidation === "superseded") {
        // A late finalizer must not clear or refresh the successor's deadline.
        controls.close();
      }
      await vi.advanceTimersByTimeAsync(RUNTIME_TIMEOUT_MS - 2);
      expect(getCommandLaneSnapshot(GLOBAL_LANE).activeCount).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(controller.abortSignal.aborted).toBe(true);
      await expect(observed).resolves.toMatchObject({ name: "CommandLaneTaskTimeoutError" });
    },
  );
});

describe("attempt cancellation unwind", () => {
  test.each(["parent Stop", "attempt Stop", "runtime timeout"] as const)(
    "%s releases an uncooperative lane after one 30-second grace",
    async (source) => {
      const parentAbort = new AbortController();
      const { controller, createAttemptControls } = await createRunController({
        abortSignal: parentAbort.signal,
      });
      const onAbort = vi.fn();
      const controls = createAttemptControls({ initialTimeoutMs: MAX_TIMER_TIMEOUT_MS, onAbort });
      const { observed } = await holdLane(controller);
      const next = vi.fn(async () => "next");
      const queued = enqueueCommandInLane(GLOBAL_LANE, next);
      const timeout = new Error("runtime idle timeout");
      const cancel = () => {
        if (source === "parent Stop") {
          parentAbort.abort();
        } else if (source === "attempt Stop") {
          controls.onAttemptAbort();
        } else {
          controls.onAttemptTimeout(timeout);
        }
      };
      cancel();
      if (source === "parent Stop") {
        // The original attempt can unwind before an isolated finalizer stalls.
        controls.close();
      }
      expect(controls.abortSignal.aborted).toBe(source !== "runtime timeout");
      if (source === "attempt Stop") {
        expect(isAgentRunDirectAbortReason(controls.abortSignal.reason)).toBe(true);
      }
      await vi.advanceTimersByTimeAsync(29_999);
      expect(getCommandLaneSnapshot(GLOBAL_LANE)).toMatchObject({ activeCount: 1, queuedCount: 1 });
      expect(next).not.toHaveBeenCalled();
      cancel();
      await vi.advanceTimersByTimeAsync(1);
      expect(controls.abortSignal.aborted).toBe(true);
      await expect(observed).resolves.toMatchObject({ name: "CommandLaneTaskTimeoutError" });
      await expect(queued).resolves.toBe("next");
      expect(onAbort).toHaveBeenCalledTimes(source === "attempt Stop" ? 1 : 0);
    },
  );

  test("commits Stop before a reentrant abort callback creates another attempt", async () => {
    const { controller, createAttemptControls } = await createRunController();
    const successorAbort = vi.fn();
    const onAbort = vi.fn(() => {
      expect(controller.abortSignal.aborted).toBe(true);
      controls.onAttemptAbort();
      const successor = createAttemptControls({
        initialTimeoutMs: MAX_TIMER_TIMEOUT_MS,
        onAbort: successorAbort,
      });
      expect(successor.abortSignal.aborted).toBe(true);
      successor.onAttemptDeadlineChanged({ kind: "unlimited" });
      successor.onAttemptTimeout(new Error("late timeout"));
      successor.onAttemptAbort();
      controls.close();
    });
    const controls = createAttemptControls({ initialTimeoutMs: MAX_TIMER_TIMEOUT_MS, onAbort });
    const { observed } = await holdLane(controller);
    controls.onAttemptAbort();
    expect(onAbort).toHaveBeenCalledOnce();
    expect(successorAbort).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(29_999);
    expect(getCommandLaneSnapshot(GLOBAL_LANE).activeCount).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(getCommandLaneSnapshot(GLOBAL_LANE).activeCount).toBe(0);
    await expect(observed).resolves.toMatchObject({ name: "CommandLaneTaskTimeoutError" });
  });
});
