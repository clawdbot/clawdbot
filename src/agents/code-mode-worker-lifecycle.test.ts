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
import { CodeModeOutputState, EMPTY_CODE_MODE_OUTPUT } from "./code-mode-json.js";
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
import { ToolSearchRuntime } from "./tool-search-runtime.js";
import {
  createToolSearchCatalogRef,
  clearToolSearchCatalog,
  registerHeadlessToolSearchCatalog,
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
    snapshot: {
      memory: new Uint8Array([1]),
      stackPointer: 0,
      runtimePtr: 0,
      contextPtr: 0,
      extensions: [],
    },
    parentToolCallId: "code-mode-lifecycle",
    ctx,
    config,
    runtime,
    catalogProjection: createCodeModeCatalogProjection([]),
    namespaceRuntime: createCodeModeNamespaceRuntime(),
    output: new CodeModeOutputState(config.maxOutputBytes),
    bridgeDispatch: createCodeModeBridgeDispatchState(),
  });
  return { cancel, runId: owner.runId };
}

afterEach(() => {
  disposeAllCodeModeRuns();
  vi.useRealTimers();
});

describe("Code Mode worker lifecycle", () => {
  it("transfers snapshot heaps across resumes without storage codec copies", async () => {
    const tempDirs = useAutoCleanupTempDirTracker(onTestFinished);
    const dir = tempDirs.make("code-mode-snapshot-transfer-");
    const workerPath = path.join(dir, "snapshot-worker.ts");
    const quickJsUrl = pathToFileURL(createRequire(import.meta.url).resolve("quickjs-wasi"));
    await writeFile(path.join(dir, "package.json"), '{"type":"module"}');
    // The dependency's storage codec copies the whole heap in both directions.
    // Exercise real snapshots and restores while allowing metadata-only accounting.
    await writeFile(
      workerPath,
      `
      import { parentPort } from "node:worker_threads";
      const { QuickJS } = await import(${JSON.stringify(quickJsUrl.href)});
      const serialize = QuickJS.serializeSnapshot;
      QuickJS.serializeSnapshot = (snapshot) => {
        if (snapshot.memory.byteLength > 0) throw new Error("snapshot heap serialization copies memory");
        return serialize(snapshot);
      };
      QuickJS.deserializeSnapshot = () => { throw new Error("snapshot heap deserialization copies memory"); };
      const postMessage = parentPort.postMessage.bind(parentPort);
      parentPort.postMessage = (message, transferList) => {
        if (message.value?.status === "waiting" &&
            !transferList?.includes(message.value.snapshot.memory.buffer)) {
          throw new Error("snapshot heap must transfer to the host");
        }
        postMessage(message, transferList);
      };
      await import(${JSON.stringify(new URL("./code-mode.worker.ts", import.meta.url).href)});
      `,
    );
    const workerUrl = pathToFileURL(workerPath);
    const config = resolveCodeModeConfig({ tools: { codeMode: true } } as never);
    let result = await runCodeModeWorker(
      {
        kind: "exec",
        source: `const bytes = new Uint8Array(1024 * 1024);
          bytes[0] = 7;
          await yield_control();
          bytes[bytes.length - 1] = bytes[0] + 2;
          await yield_control();
          return [bytes.length, bytes[0], bytes[bytes.length - 1]];`,
        config,
        catalog: [],
      },
      10_000,
      workerUrl,
    );
    for (let leg = 0; leg < 2; leg++) {
      expect(result, result.status === "failed" ? result.error : undefined).toMatchObject({
        status: "waiting",
      });
      if (result.status !== "waiting") {
        throw new Error("expected a suspended guest");
      }
      const memory = result.snapshot.memory.buffer;
      result = await runCodeModeWorker(
        {
          kind: "resume",
          snapshot: result.snapshot,
          config,
          settledRequests: result.pendingRequests.map(({ id }) => ({ id, ok: true, value: null })),
        },
        10_000,
        workerUrl,
      );
      expect(memory.byteLength).toBe(0);
    }
    expect(result).toMatchObject({
      status: "completed",
      value: { kind: "complete", json: "[1048576,7,9]" },
    });
  });

  it("isolates guest globals, bridge failures, and cancellations across warm executions", async () => {
    const config = resolveCodeModeConfig({
      tools: { codeMode: { enabled: true, maxPendingToolCalls: 1 } },
    } as never);
    const execute = (source: string) =>
      runCodeModeWorker({ kind: "exec", source, config, catalog: [] }, 10_000);

    expect(
      await execute(
        "globalThis.previousRun = true; setTimeout(() => {}, 1); setTimeout(() => {}, 2);",
      ),
    ).toMatchObject({ status: "failed", code: "invalid_input" });
    const cancelled = await execute(
      'const timer = setTimeout(() => {}, 1); clearTimeout(timer); await yield_control("pause");',
    );
    expect(cancelled).toMatchObject({
      status: "waiting",
      canceledRequestIds: ["bridge:sleep:1"],
    });
    expect(await execute('await yield_control("next session");')).toMatchObject({
      status: "waiting",
      canceledRequestIds: [],
      pendingRequests: [{ id: "bridge:yield:1", method: "yield" }],
    });
    expect(await execute("return typeof globalThis.previousRun;")).toMatchObject({
      status: "completed",
      value: { kind: "complete", json: '"undefined"' },
    });
  });

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
      // Changing the runtime entry also retires idle warm workers. The active
      // CPU worker is the last termination, and must stop before abort settles.
      expect(terminate).toHaveBeenCalled();
      const worker = terminate.mock.contexts.at(-1);
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
          snapshot: suspended.snapshot,
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
            ? { status: "completed", value: { kind: "complete", json: "4999950000" } }
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
      output: EMPTY_CODE_MODE_OUTPUT,
    });
  });

  it("shares a compiled QuickJS module with isolated worker threads", async () => {
    const config = resolveCodeModeConfig({ tools: { codeMode: true } } as never);
    const workerUrl = new URL(
      `data:text/javascript,${encodeURIComponent(`
        import { parentPort } from "node:worker_threads";
        parentPort.on("message", ({ input }) => parentPort.postMessage({
          status: "ok",
          value: {
            status: "completed",
            value: { kind: "complete", json: JSON.stringify(input.wasmModule instanceof WebAssembly.Module) },
            output: { count: 0, source: { kind: "complete", json: "[]" } },
          },
        }));
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
        value: { kind: "complete", json: "true" },
        output: EMPTY_CODE_MODE_OUTPUT,
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

      if (result.status === "failed") {
        expect(result.code).toBe("internal_error");
        expect(result.error).toContain("boom");
      }
      const outputBytes = Buffer.byteLength(result.output.source.json);
      const valueBytes = result.status === "completed" ? Buffer.byteLength(result.value.json) : 0;
      const errorBytes =
        result.status === "failed" ? Buffer.byteLength(JSON.stringify(result.error)) : 0;
      expect(outputBytes).toBeLessThanOrEqual(1_024);
      expect(valueBytes).toBeLessThanOrEqual(1_024);
      expect(outputBytes + valueBytes + errorBytes).toBeLessThanOrEqual(2 * 1_024);
      const state = new CodeModeOutputState(1_024);
      state.append(result.output);
      const projected = state.take(
        result.status === "completed"
          ? { value: result.value }
          : result.status === "failed"
            ? { error: result.error }
            : {},
      );
      expect(JSON.stringify(projected)).toContain("rerun with narrower args");
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
