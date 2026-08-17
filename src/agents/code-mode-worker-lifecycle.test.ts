import { afterEach, describe, expect, it, vi } from "vitest";
import { createCodeModeNamespaceRuntime } from "./code-mode-namespaces.js";
import { resolveCodeModeConfig, toToolSearchConfig } from "./code-mode-runtime.js";
import {
  activeRuns,
  disposeAllCodeModeRuns,
  disposeCodeModeRun,
  reserveActiveRunSlot,
  resumingRunIds,
  storeSnapshotState,
  type PendingBridgeState,
} from "./code-mode-state.js";
import { runCodeModeWorker } from "./code-mode-worker.js";
import {
  createToolSearchCatalogRef,
  registerHeadlessToolSearchCatalog,
  ToolSearchRuntime,
} from "./tool-search.js";

const EXPIRING_RUN_ID = "cm_worker_lifecycle_expiry";
const CAPACITY_RUN_PREFIX = "cm_worker_lifecycle_capacity_";

function parkExpiringRun(
  method: "callValue" | "agentWait",
  runId = EXPIRING_RUN_ID,
): ReturnType<typeof vi.fn> {
  const rawConfig = {
    tools: { codeMode: { enabled: true, snapshotTtlSeconds: 1 } },
  } as never;
  const config = resolveCodeModeConfig(rawConfig);
  const catalogRef = createToolSearchCatalogRef();
  registerHeadlessToolSearchCatalog({ catalogRef, tools: [] });
  const ctx = { config: rawConfig, runtimeConfig: rawConfig, catalogRef };
  const runtime = new ToolSearchRuntime(ctx, toToolSearchConfig(config));
  const cancel = vi.fn();
  const pending: PendingBridgeState = {
    id: `bridge:${method}:1`,
    method,
    args: method === "agentWait" ? ["collector-1"] : ["openclaw:core:slow", {}],
    promise: new Promise(() => {}),
    cancel,
  };

  storeSnapshotState({
    runId,
    replayId: "cm_replay_lifecycle",
    pending: [pending],
    replaySafe: false,
    settlementMode: { kind: "awaiting" },
    snapshotBytes: new Uint8Array([1]),
    parentToolCallId: "code-mode-lifecycle",
    ctx,
    config,
    runtime,
    namespaceRuntime: createCodeModeNamespaceRuntime(),
    output: [],
  });
  return cancel;
}

afterEach(() => {
  disposeCodeModeRun(EXPIRING_RUN_ID);
  for (const runId of activeRuns.keys()) {
    if (runId.startsWith(CAPACITY_RUN_PREFIX)) {
      disposeCodeModeRun(runId);
    }
  }
  vi.useRealTimers();
});

describe("Code Mode worker lifecycle", () => {
  it("cancels every suspended run, releases capacity, and clears its expiry timer", () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const firstRunId = `${CAPACITY_RUN_PREFIX}shutdown_first`;
    const secondRunId = `${CAPACITY_RUN_PREFIX}shutdown_second`;
    const firstCancel = parkExpiringRun("callValue", firstRunId);
    const secondCancel = parkExpiringRun("agentWait", secondRunId);
    const firstRun = activeRuns.get(firstRunId);
    if (!firstRun) {
      throw new Error("expected a parked Code Mode shutdown run");
    }
    resumingRunIds.add(firstRunId);
    resumingRunIds.add(secondRunId);
    for (let index = 0; index < 62; index += 1) {
      const runId = `${CAPACITY_RUN_PREFIX}shutdown_${index}`;
      activeRuns.set(runId, { ...firstRun, runId, pending: [] });
    }

    expect(activeRuns.size).toBe(64);
    expect(() => reserveActiveRunSlot()).toThrow("too many suspended code mode runs");
    expect(vi.getTimerCount()).toBe(1);

    const clearExpiryTimer = vi.spyOn(globalThis, "clearTimeout");
    disposeAllCodeModeRuns();
    disposeAllCodeModeRuns();

    expect(firstCancel).toHaveBeenCalledOnce();
    expect(secondCancel).toHaveBeenCalledOnce();
    expect(clearExpiryTimer).toHaveBeenCalledOnce();
    expect(activeRuns.size).toBe(0);
    expect(resumingRunIds.has(firstRunId)).toBe(false);
    expect(resumingRunIds.has(secondRunId)).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    clearExpiryTimer.mockRestore();

    const releaseFreedSlot = reserveActiveRunSlot();
    releaseFreedSlot();
  });

  it("transfers a resumed run's slot atomically at the suspended-run limit", () => {
    parkExpiringRun("callValue");
    const ownedState = activeRuns.get(EXPIRING_RUN_ID);
    expect(ownedState).toBeDefined();
    if (!ownedState) {
      throw new Error("expected a parked Code Mode run");
    }
    for (let index = 0; index < 63; index += 1) {
      const runId = `${CAPACITY_RUN_PREFIX}${index}`;
      activeRuns.set(runId, { ...ownedState, runId, pending: [] });
    }

    const release = reserveActiveRunSlot(EXPIRING_RUN_ID);
    try {
      expect(activeRuns.has(EXPIRING_RUN_ID)).toBe(false);
      expect(activeRuns.size).toBe(63);
      expect(() => reserveActiveRunSlot()).toThrow("too many suspended code mode runs");

      activeRuns.set(EXPIRING_RUN_ID, ownedState);
    } finally {
      release();
    }

    expect(activeRuns.size).toBe(64);
    expect(() => reserveActiveRunSlot()).toThrow("too many suspended code mode runs");

    disposeCodeModeRun(`${CAPACITY_RUN_PREFIX}0`);
    const releaseFreedSlot = reserveActiveRunSlot();
    releaseFreedSlot();
  });

  it("rejects an unavailable run without leaking a capacity reservation", () => {
    expect(() => reserveActiveRunSlot("cm_missing_lifecycle_owner")).toThrow(
      "code mode run is unavailable or expired",
    );

    const release = reserveActiveRunSlot();
    release();
  });

  it("honors an already-aborted execution before starting a worker", async () => {
    const config = resolveCodeModeConfig({ tools: { codeMode: true } } as never);
    const controller = new AbortController();
    controller.abort();

    const result = await runCodeModeWorker(
      {
        kind: "exec",
        source: "return true;",
        config,
        catalog: [],
      },
      10_000,
      undefined,
      controller.signal,
    );

    expect(result).toMatchObject({
      status: "failed",
      code: "aborted",
      error: "code mode execution aborted",
      output: [],
    });
  });

  it("shares a compiled QuickJS module with isolated worker threads", async () => {
    const config = resolveCodeModeConfig({ tools: { codeMode: true } } as never);
    const workerUrl = new URL(
      `data:text/javascript,${encodeURIComponent(`
        import { parentPort, workerData } from "node:worker_threads";
        parentPort.postMessage({
          status: "completed",
          value: workerData.wasmModule instanceof WebAssembly.Module,
          output: [],
        });
      `)}`,
    );

    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        runCodeModeWorker(
          {
            kind: "exec",
            source: "return true;",
            config,
            catalog: [],
          },
          10_000,
          workerUrl,
        ),
      ),
    );

    expect(results).toEqual(
      Array.from({ length: 4 }, () => ({
        status: "completed",
        value: true,
        output: [],
      })),
    );
  });

  it.each([
    { label: "returned values", source: 'return "x".repeat(2_048);', status: "completed" },
    {
      label: "completed output",
      source: 'text("x".repeat(2_048)); return true;',
      status: "completed",
    },
    {
      label: "combined output and returned values",
      source: 'text("x".repeat(700)); return "y".repeat(700);',
      status: "completed",
    },
    {
      label: "suspended output",
      source: 'text("x".repeat(2_048)); await yield_control("pause"); return true;',
      status: "waiting",
    },
    {
      label: "failed output",
      source: 'text("x".repeat(2_048)); throw new Error("boom");',
      status: "failed",
    },
  ])(
    "bounds oversized $label before sending it across worker threads",
    async ({ source, status }) => {
      const config = resolveCodeModeConfig({
        tools: { codeMode: { enabled: true, maxOutputBytes: 1_024 } },
      } as never);

      const result = await runCodeModeWorker(
        {
          kind: "exec",
          source,
          config,
          catalog: [],
        },
        10_000,
      );

      expect(result.status).toBe(status);
      expect(JSON.stringify(result)).toContain("rerun with narrower args");
      if (result.status === "failed") {
        expect(result.code).toBe("internal_error");
        expect(result.error).toContain("boom");
      }
      const outputBytes =
        result.output.length > 0 ? Buffer.byteLength(JSON.stringify(result.output), "utf8") : 0;
      const valueBytes =
        result.status === "completed" ? Buffer.byteLength(JSON.stringify(result.value), "utf8") : 0;
      expect(outputBytes + valueBytes).toBeLessThanOrEqual(1_024);
    },
  );

  it("expires an idle suspended snapshot and aborts its outstanding tool", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const cancel = parkExpiringRun("callValue");

    expect(activeRuns.has(EXPIRING_RUN_ID)).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(activeRuns.has(EXPIRING_RUN_ID)).toBe(false);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("retains an active collector only within its bounded snapshot TTL windows", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const cancel = parkExpiringRun("agentWait");

    await vi.advanceTimersByTimeAsync(1_000);
    expect(activeRuns.has(EXPIRING_RUN_ID)).toBe(true);
    expect(cancel).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(3_000);
    expect(activeRuns.has(EXPIRING_RUN_ID)).toBe(false);
    expect(cancel).toHaveBeenCalledOnce();
  });
});
