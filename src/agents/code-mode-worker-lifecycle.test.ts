import { afterEach, describe, expect, it, vi } from "vitest";
import { createCodeModeNamespaceRuntime } from "./code-mode-namespaces.js";
import { CodeModePrivateAuthority } from "./code-mode-private-authority.js";
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
    conversationList: false,
    promise: new Promise(() => {}),
    cancel,
  };

  storeSnapshotState({
    runId,
    replayId: "cm_replay_lifecycle",
    pending: [pending],
    enforceReplaySafeTools: false,
    replaySafe: false,
    settlementMode: { kind: "awaiting" },
    snapshotBytes: new Uint8Array([1]),
    parentToolCallId: "code-mode-lifecycle",
    ctx,
    config,
    runtime,
    namespaceRuntime: createCodeModeNamespaceRuntime(),
    privateAuthority: new CodeModePrivateAuthority(),
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

  it("honors an already-aborted execution without reporting a spawned worker", async () => {
    const config = resolveCodeModeConfig({ tools: { codeMode: true } } as never);
    const controller = new AbortController();
    controller.abort();
    const onWorkerSpawned = vi.fn();

    const result = await runCodeModeWorker({
      workerData: {
        kind: "exec",
        source: "return true;",
        config,
        catalog: [],
      },
      timeoutMs: 10_000,
      signal: controller.signal,
      onWorkerSpawned,
    });

    expect(result).toMatchObject({
      status: "failed",
      code: "aborted",
      error: "code mode execution aborted",
      output: [],
    });
    expect(result.snapshotAttempt).toBeUndefined();
    expect(onWorkerSpawned).not.toHaveBeenCalled();
  });

  it("does not report a worker when construction fails", async () => {
    const config = resolveCodeModeConfig({ tools: { codeMode: true } } as never);
    const onWorkerSpawned = vi.fn();

    const result = await runCodeModeWorker({
      workerData: {
        kind: "exec",
        source: "return true;",
        config,
        catalog: [],
      },
      timeoutMs: 10_000,
      workerUrl: new URL("https://example.invalid/code-mode.worker.js"),
      onWorkerSpawned,
    });

    expect(result).toMatchObject({
      status: "failed",
      code: "runtime_unavailable",
    });
    expect(onWorkerSpawned).not.toHaveBeenCalled();
  });

  it("shares a compiled QuickJS module with isolated worker threads", async () => {
    const config = resolveCodeModeConfig({ tools: { codeMode: true } } as never);
    const onWorkerSpawned = vi.fn();
    const workerUrl = new URL(
      `data:text/javascript,${encodeURIComponent(`
        import { parentPort, workerData } from "node:worker_threads";
        parentPort.postMessage({
          kind: "result",
          result: {
            status: "completed",
            value: workerData.wasmModule instanceof WebAssembly.Module,
            output: [],
          },
        });
      `)}`,
    );

    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        runCodeModeWorker({
          workerData: {
            kind: "exec",
            source: "return true;",
            config,
            catalog: [],
          },
          timeoutMs: 10_000,
          workerUrl,
          onWorkerSpawned,
        }),
      ),
    );

    expect(results).toEqual(
      Array.from({ length: 4 }, () => ({
        status: "completed",
        value: true,
        output: [],
      })),
    );
    expect(onWorkerSpawned).toHaveBeenCalledTimes(4);
  });

  it.each([
    {
      name: "duplicate start",
      messages: [{ kind: "snapshot_started" }, { kind: "snapshot_started" }],
      expectedAttempt: {
        disposition: "rejected",
        rejectionReason: "schema",
        coverage: "lower_bound",
      },
    },
    {
      name: "produced before start",
      messages: [{ kind: "snapshot_produced", bytes: 64, serializationMs: 2 }],
      expectedAttempt: {
        disposition: "rejected",
        rejectionReason: "schema",
        measurement: { bytes: 64, serializationMs: 2 },
        coverage: "exact",
      },
    },
    {
      name: "invalid production before start",
      messages: [{ kind: "snapshot_produced", bytes: -1, serializationMs: 2 }],
      expectedAttempt: {
        disposition: "rejected",
        rejectionReason: "schema",
        coverage: "lower_bound",
      },
    },
    {
      name: "invalid terminal schema",
      messages: [
        { kind: "snapshot_started" },
        { kind: "snapshot_produced", bytes: 64, serializationMs: 2 },
        { kind: "result", result: { status: "waiting", output: [] } },
      ],
      expectedAttempt: {
        disposition: "rejected",
        rejectionReason: "schema",
        measurement: { bytes: 64, serializationMs: 2 },
        coverage: "exact",
      },
    },
  ])("rejects $name worker snapshot protocols", async ({ messages, expectedAttempt }) => {
    const workerUrl = new URL(
      `data:text/javascript,${encodeURIComponent(`
        import { parentPort } from "node:worker_threads";
        for (const message of ${JSON.stringify(messages)}) parentPort.postMessage(message);
      `)}`,
    );
    const result = await runCodeModeWorker({
      workerData: {},
      timeoutMs: 1_000,
      workerUrl,
    });

    expect(result).toMatchObject({
      status: "failed",
      code: "internal_error",
      error: "invalid code mode worker response",
    });
    expect(result.snapshotAttempt).toEqual(expectedAttempt);
  });

  it.each<{ name: string; terminal: string; maxSnapshotBytes?: number }>([
    {
      name: "malformed pending request",
      terminal: `{
        status: "waiting",
        snapshotBytes: new Uint8Array(64),
        pendingRequests: [{}],
        settlementMode: { kind: "awaiting" },
        output: [],
      }`,
    },
    {
      name: "awaiting frontier without host work",
      terminal: `{
        status: "waiting",
        snapshotBytes: new Uint8Array(64),
        pendingRequests: [],
        settlementMode: { kind: "awaiting" },
        output: [],
      }`,
    },
    {
      name: "unknown pending request method",
      terminal: `{
        status: "waiting",
        snapshotBytes: new Uint8Array(64),
        pendingRequests: [{ id: "bridge:unknown:1", method: "unknown", args: [], argumentBytes: 2 }],
        settlementMode: { kind: "awaiting" },
        output: [],
      }`,
    },
    {
      name: "non-array pending request arguments",
      terminal: `{
        status: "waiting",
        snapshotBytes: new Uint8Array(64),
        pendingRequests: [{ id: "bridge:call:1", method: "call", args: {}, argumentBytes: 2 }],
        settlementMode: { kind: "awaiting" },
        output: [],
      }`,
    },
    {
      name: "negative pending request argument bytes",
      terminal: `{
        status: "waiting",
        snapshotBytes: new Uint8Array(64),
        pendingRequests: [{ id: "bridge:call:1", method: "call", args: [], argumentBytes: -1 }],
        settlementMode: { kind: "awaiting" },
        output: [],
      }`,
    },
    {
      name: "method-mismatched pending request id",
      terminal: `{
        status: "waiting",
        snapshotBytes: new Uint8Array(64),
        pendingRequests: [{ id: "bridge:search:1", method: "call", args: [], argumentBytes: 2 }],
        settlementMode: { kind: "awaiting" },
        output: [],
      }`,
    },
    {
      name: "duplicate pending request id",
      terminal: `{
        status: "waiting",
        snapshotBytes: new Uint8Array(64),
        pendingRequests: [
          { id: "bridge:call:1", method: "call", args: [], argumentBytes: 2 },
          { id: "bridge:call:1", method: "call", args: [], argumentBytes: 2 },
        ],
        settlementMode: { kind: "awaiting" },
        output: [],
      }`,
    },
    {
      name: "cyclic pending request arguments",
      terminal: `(() => {
        const args = [];
        args.push(args);
        return {
          status: "waiting",
          snapshotBytes: new Uint8Array(64),
          pendingRequests: [{ id: "bridge:call:1", method: "call", args, argumentBytes: 2 }],
          settlementMode: { kind: "awaiting" },
          output: [],
        };
      })()`,
    },
    {
      name: "cyclic worker output",
      terminal: `(() => {
        const output = [];
        output.push(output);
        return {
          status: "waiting",
          snapshotBytes: new Uint8Array(64),
          pendingRequests: [{ id: "bridge:call:1", method: "call", args: [], argumentBytes: 2 }],
          settlementMode: { kind: "awaiting" },
          output,
        };
      })()`,
    },
    {
      name: "inexact pending request argument bytes",
      terminal: `{
        status: "waiting",
        snapshotBytes: new Uint8Array(64),
        pendingRequests: [{ id: "bridge:call:1", method: "call", args: [], argumentBytes: 3 }],
        settlementMode: { kind: "awaiting" },
        output: [],
      }`,
    },
    {
      name: "non-string draining request id",
      terminal: `{
        status: "waiting",
        snapshotBytes: new Uint8Array(64),
        pendingRequests: [{ id: "bridge:call:1", method: "call", args: [], argumentBytes: 2 }],
        settlementMode: { kind: "draining", requiredRequestIds: [1] },
        output: [],
      }`,
    },
    {
      name: "duplicate draining request id",
      terminal: `{
        status: "waiting",
        snapshotBytes: new Uint8Array(64),
        pendingRequests: [
          { id: "bridge:call:1", method: "call", args: [], argumentBytes: 2 },
          { id: "bridge:call:2", method: "call", args: [], argumentBytes: 2 },
        ],
        settlementMode: {
          kind: "draining",
          requiredRequestIds: ["bridge:call:1", "bridge:call:1"],
        },
        output: [],
      }`,
    },
    {
      name: "unknown draining request id",
      terminal: `{
        status: "waiting",
        snapshotBytes: new Uint8Array(64),
        pendingRequests: [
          { id: "bridge:call:1", method: "call", args: [], argumentBytes: 2 },
          { id: "bridge:call:2", method: "call", args: [], argumentBytes: 2 },
        ],
        settlementMode: {
          kind: "draining",
          requiredRequestIds: ["bridge:call:1", "bridge:search:1"],
        },
        output: [],
      }`,
    },
    {
      name: "unknown failure code",
      terminal: `{
        status: "failed",
        error: "synthetic failure",
        code: "unknown_failure",
        failurePhase: "guest",
        bridgeDispatchStarted: false,
        output: [],
      }`,
    },
    {
      name: "mismatched measured snapshot bytes",
      terminal: `{
        status: "waiting",
        snapshotBytes: new Uint8Array(8),
        pendingRequests: [{ id: "bridge:call:1", method: "call", args: [], argumentBytes: 2 }],
        settlementMode: { kind: "awaiting" },
        output: [],
      }`,
    },
    {
      name: "oversized accepted snapshot",
      maxSnapshotBytes: 32,
      terminal: `{
        status: "waiting",
        snapshotBytes: new Uint8Array(64),
        pendingRequests: [{ id: "bridge:call:1", method: "call", args: [], argumentBytes: 2 }],
        settlementMode: { kind: "awaiting" },
        output: [],
      }`,
    },
    {
      name: "false snapshot size rejection",
      maxSnapshotBytes: 128,
      terminal: `{
        status: "failed",
        error: "synthetic size failure",
        code: "snapshot_limit_exceeded",
        failurePhase: "guest",
        bridgeDispatchStarted: false,
        output: [],
      }`,
    },
  ])("rejects $name in a terminal worker result", async ({ terminal, maxSnapshotBytes = 128 }) => {
    const workerUrl = new URL(
      `data:text/javascript,${encodeURIComponent(`
        import { parentPort } from "node:worker_threads";
        parentPort.postMessage({ kind: "snapshot_started" });
        parentPort.postMessage({ kind: "snapshot_produced", bytes: 64, serializationMs: 2 });
        parentPort.postMessage({ kind: "result", result: ${terminal} });
      `)}`,
    );
    const result = await runCodeModeWorker({
      workerData: { config: { maxSnapshotBytes } },
      timeoutMs: 1_000,
      workerUrl,
    });

    expect(result).toMatchObject({
      status: "failed",
      code: "internal_error",
      error: "invalid code mode worker response",
    });
    expect(result.snapshotAttempt).toEqual({
      disposition: "rejected",
      rejectionReason: "schema",
      measurement: { bytes: 64, serializationMs: 2 },
      coverage: "exact",
    });
  });

  it.each([
    {
      name: "abort",
      body: "setInterval(() => {}, 1000);",
      timeoutMs: 1_000,
      abort: true,
      code: "aborted",
    },
    {
      name: "timeout",
      body: "setInterval(() => {}, 1000);",
      timeoutMs: 25,
      abort: false,
      code: "timeout",
    },
    {
      name: "crash",
      body: 'throw new Error("synthetic worker crash");',
      timeoutMs: 1_000,
      abort: false,
      code: "runtime_unavailable",
      produced: false,
    },
    {
      name: "crash after production",
      body: `
        parentPort.postMessage({ kind: "snapshot_produced", bytes: 64, serializationMs: 2 });
        throw new Error("synthetic worker crash");
      `,
      timeoutMs: 1_000,
      abort: false,
      code: "runtime_unavailable",
      produced: true,
    },
  ])(
    "marks a snapshot $name after start as incomplete",
    async ({ body, timeoutMs, abort, code, produced = false }) => {
      const workerUrl = new URL(
        `data:text/javascript,${encodeURIComponent(`
        import { parentPort } from "node:worker_threads";
        parentPort.postMessage({ kind: "snapshot_started" });
        ${body}
      `)}`,
      );
      const controller = new AbortController();
      const resultPromise = runCodeModeWorker({
        workerData: {},
        timeoutMs,
        workerUrl,
        signal: controller.signal,
      });
      if (abort) {
        setTimeout(() => controller.abort(), 50);
      }

      const result = await resultPromise;
      expect(result).toMatchObject({ status: "failed", code });
      expect(result.snapshotAttempt).toEqual({
        disposition: "incomplete",
        ...(produced ? { measurement: { bytes: 64, serializationMs: 2 } } : {}),
        coverage: produced ? "exact" : "lower_bound",
      });
    },
  );

  it.each([
    { label: "returned values", source: 'return "x".repeat(2_048);' },
    { label: "completed output", source: 'text("x".repeat(2_048)); return true;' },
    {
      label: "combined output and returned values",
      source: 'text("x".repeat(700)); return "y".repeat(700);',
    },
    {
      label: "suspended output",
      source: 'text("x".repeat(2_048)); await yield_control("pause"); return true;',
    },
    { label: "failed output", source: 'text("x".repeat(2_048)); throw new Error("boom");' },
  ])("rejects oversized $label before sending it across worker threads", async ({ source }) => {
    const config = resolveCodeModeConfig({
      tools: { codeMode: { enabled: true, maxOutputBytes: 1_024 } },
    } as never);

    const result = await runCodeModeWorker({
      workerData: {
        kind: "exec",
        source,
        config,
        catalog: [],
      },
      timeoutMs: 10_000,
    });

    expect(result.status).toBe("failed");
    if (result.status !== "failed") {
      return;
    }
    expect(result.code).toBe("output_limit_exceeded");
    expect(result.error).toBe("code mode output limit exceeded");
    expect(result.output).toEqual([]);
  });

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
