import { afterEach, describe, expect, it, vi } from "vitest";
import { createCodeModeNamespaceRuntime } from "./code-mode-namespaces.js";
import { resolveCodeModeConfig, toToolSearchConfig } from "./code-mode-runtime.js";
import {
  activeRuns,
  disposeCodeModeRun,
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

function parkExpiringRun(method: "callValue" | "agentWait"): ReturnType<typeof vi.fn> {
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
    runId: EXPIRING_RUN_ID,
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
  vi.useRealTimers();
});

describe("Code Mode worker lifecycle", () => {
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

    const result = await runCodeModeWorker(
      {
        kind: "exec",
        source,
        config,
        catalog: [],
      },
      10_000,
    );

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
