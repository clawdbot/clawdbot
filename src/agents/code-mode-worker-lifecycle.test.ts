import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { BroadcastChannel, Worker } from "node:worker_threads";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as workerUrls from "../infra/runtime-worker-url.js";
import { createCodeModeCatalogProjection } from "./code-mode-catalog.js";
import { createCodeModeNamespaceRuntime } from "./code-mode-namespaces.js";
import { resolveCodeModeConfig, toToolSearchConfig } from "./code-mode-runtime.js";
import {
  activeRuns,
  createCodeModeBridgeDispatchState,
  createCodeModeRunOwner,
  disposeAllCodeModeRuns,
  reserveActiveRunSlot,
  storeSnapshotState,
  type PendingBridgeState,
} from "./code-mode-state.js";
import { runCodeModeWorker } from "./code-mode-worker.js";
import { applyCodeModeCatalog } from "./code-mode.js";
import { createCodeModeHarness, resultDetails } from "./code-mode.test-support.js";
import {
  createToolSearchCatalogRef,
  clearToolSearchCatalog,
  registerHeadlessToolSearchCatalog,
  ToolSearchRuntime,
} from "./tool-search.js";

function parkExpiringRun(method: "callValue" | "agentWait") {
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

  const owner = createCodeModeRunOwner(ctx);
  storeSnapshotState({
    owner,
    replayId: "cm_replay_lifecycle",
    pending: [pending],
    replaySafe: false,
    settlementMode: { kind: "awaiting" },
    snapshotBytes: new Uint8Array([1]),
    parentToolCallId: "code-mode-lifecycle",
    ctx,
    config,
    runtime,
    catalogProjection: createCodeModeCatalogProjection([]),
    namespaceRuntime: createCodeModeNamespaceRuntime(),
    output: [],
    bridgeDispatch: createCodeModeBridgeDispatchState(),
  });
  return { cancel, runId: owner.runId };
}

afterEach(() => {
  disposeAllCodeModeRuns();
  vi.useRealTimers();
});

describe("Code Mode worker lifecycle", () => {
  it.each(["exec", "resume"] as const)(
    "terminates a real CPU-active %s worker when its catalog closes",
    async (phase) => {
      // Finish hooks unwind in reverse order: stop workers before restoring their
      // loader spies and releasing the channel and files, including on setup failure.
      const tempDirs = useAutoCleanupTempDirTracker(onTestFinished);
      const dir = tempDirs.make("code-mode-catalog-cpu-");
      const channelName = `catalog-cpu-${phase}-${crypto.randomUUID()}`;
      const channel = new BroadcastChannel(channelName);
      onTestFinished(() => channel.close());
      const executing = createDeferred();
      channel.addEventListener("message", () => executing.resolve(), { once: true });
      const h = createCodeModeHarness();
      onTestFinished(() => clearToolSearchCatalog(h.ctx));
      applyCodeModeCatalog({ ...h.ctx, tools: h.tools });
      const exec = h.tools.find((tool) => tool.name === "exec");
      const wait = h.tools.find((tool) => tool.name === "wait");
      if (!exec || !wait) {
        throw new Error("Expected Code Mode control tools");
      }
      let runId: unknown;
      if (phase === "resume") {
        const parked = resultDetails(
          await exec.execute("park-cpu", {
            code: "await yield_control(); while (true) {}",
          }),
        );
        expect(parked.status).toBe("waiting");
        runId = parked.runId;
      }
      const quickJsUrl = pathToFileURL(createRequire(import.meta.url).resolve("quickjs-wasi"));
      const workerPath = path.join(dir, "observed-worker.ts");
      await writeFile(path.join(dir, "package.json"), '{"type":"module"}');
      // Observe the real QuickJS interrupt callback, not merely thread startup.
      await writeFile(
        workerPath,
        `
        import { BroadcastChannel } from "node:worker_threads";
        const channel = new BroadcastChannel(${JSON.stringify(channelName)});
        const { QuickJS } = await import(${JSON.stringify(quickJsUrl.href)});
        for (const method of ["create", "restore"]) {
          const original = QuickJS[method];
          QuickJS[method] = function (...args) {
            const index = method === "create" ? 0 : 1;
            const options = args[index];
            const interrupt = options.interruptHandler;
            let observed = false;
            args[index] = { ...options, interruptHandler: () => {
              if (!observed) { observed = true; channel.postMessage("executing"); }
              return interrupt();
            } };
            return original.apply(this, args);
          };
        }
        await import(${JSON.stringify(new URL("./code-mode.worker.ts", import.meta.url).href)});
      `,
      );
      const resolveWorker = vi
        .spyOn(workerUrls, "resolveRuntimeWorkerUrl")
        .mockReturnValue(pathToFileURL(workerPath));
      onTestFinished(() => resolveWorker.mockRestore());
      const terminate = vi.spyOn(Worker.prototype, "terminate");
      onTestFinished(() => terminate.mockRestore());
      const execution =
        phase === "exec"
          ? exec.execute("cpu", { code: "while (true) {}" })
          : wait.execute("resume-cpu", { runId });
      onTestFinished(async () => {
        clearToolSearchCatalog(h.ctx);
        await execution;
      });
      await executing.promise;
      clearToolSearchCatalog(h.ctx);
      expect(resultDetails(await execution)).toMatchObject({ status: "failed", code: "aborted" });
      expect(terminate).toHaveBeenCalledOnce();
      const worker = terminate.mock.contexts[0];
      if (!(worker instanceof Worker)) {
        throw new Error("Expected a terminated real worker");
      }
      expect(worker.threadId).toBe(-1);
      expect(activeRuns.size).toBe(0);
      expect(h.catalogRef.onDispose).toBeUndefined();
    },
  );

  it.each(
    (["exec", "resume"] as const).flatMap((kind) =>
      [1, -1].map((clockDirection) => ({ kind, clockDirection })),
    ),
  )(
    "keeps $kind guest timeouts independent of a $clockDirection clock jump",
    async ({ kind, clockDirection }) => {
      const config = resolveCodeModeConfig({
        tools: { codeMode: { enabled: true, timeoutMs: clockDirection > 0 ? 1_000 : 250 } },
      } as never);
      const source =
        clockDirection > 0
          ? "let total = 0; for (let index = 0; index < 100_000; index++) total += index; return total;"
          : "while (true) {}";
      let input: Record<string, unknown> = { kind: "exec", source, config, catalog: [] };
      if (kind === "resume") {
        const suspended = await runCodeModeWorker(
          { ...input, source: `await yield_control("clock jump"); ${source}` },
          10_000,
        );
        expect(suspended.status).toBe("waiting");
        if (suspended.status !== "waiting") {
          throw new Error("expected a suspended guest before the clock jump");
        }
        input = {
          kind,
          config,
          snapshotBytes: suspended.snapshotBytes,
          settledRequests: suspended.pendingRequests.map(({ id }) => ({
            id,
            ok: true,
            value: null,
          })),
        };
      }

      const fixtureDir = await mkdtemp(path.join(os.tmpdir(), "code-mode-worker-clock-"));
      try {
        await writeFile(path.join(fixtureDir, "package.json"), '{"type":"module"}');
        const workerPath = path.join(fixtureDir, "clock-worker.ts");
        const quickJsUrl = pathToFileURL(createRequire(import.meta.url).resolve("quickjs-wasi"));
        const productionWorkerUrl = new URL("./code-mode.worker.ts", import.meta.url);
        // Change the clock inside the real worker, after its VM deadline starts.
        // Parent-only clock spies cannot reach this isolated thread.
        await writeFile(
          workerPath,
          `
        const { QuickJS } = await import(${JSON.stringify(quickJsUrl.href)});
        const realNow = Date.now;
        let shifted = false;
        for (const method of ["create", "restore"]) {
          const original = QuickJS[method];
          QuickJS[method] = function (...args) {
            const optionsIndex = method === "create" ? 0 : 1;
            const options = args[optionsIndex];
            const interrupt = options.interruptHandler;
            args[optionsIndex] = { ...options, interruptHandler: () => {
              if (!shifted) {
                shifted = true;
                Date.now = () => realNow() + ${clockDirection * 60_000};
              }
              return interrupt();
            } };
            return original.apply(this, args);
          };
        }
        await import(${JSON.stringify(productionWorkerUrl.href)});
      `,
        );
        const result = await runCodeModeWorker(input, 5_000, pathToFileURL(workerPath));
        expect(result, JSON.stringify(result)).toMatchObject(
          clockDirection > 0
            ? { status: "completed", value: 4_999_950_000 }
            : { status: "failed", code: "timeout", failurePhase: "guest" },
        );
      } finally {
        await rm(fixtureDir, { recursive: true, force: true });
      }
    },
  );

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
    const { cancel, runId } = parkExpiringRun("callValue");

    expect(activeRuns.has(runId)).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(activeRuns.has(runId)).toBe(false);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("retains an active collector only within its bounded snapshot TTL windows", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const { cancel, runId } = parkExpiringRun("agentWait");

    await vi.advanceTimersByTimeAsync(1_000);
    expect(activeRuns.has(runId)).toBe(true);
    expect(cancel).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(3_000);
    expect(activeRuns.has(runId)).toBe(false);
    expect(cancel).toHaveBeenCalledOnce();
  });
});
