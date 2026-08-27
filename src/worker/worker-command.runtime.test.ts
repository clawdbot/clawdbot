import { Console } from "node:console";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  WORKER_PROTOCOL_FEATURES,
  WORKER_RPC_SET_VERSION,
} from "../../packages/gateway-protocol/src/schema/worker-admission.js";
import { WORKER_PROTOCOL_MAX_INFERENCE_PAYLOAD_BYTES } from "../../packages/gateway-protocol/src/schema/worker-inference.js";
import { createDeferred } from "../../test/helpers/promise.js";
import { setLoggerOverride } from "../logging/logger.js";
import { loggingState } from "../logging/state.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { WorkerBrowserRuntime } from "./browser-runtime.js";
import type { WorkerLaunchDescriptor } from "./launch-descriptor.js";
import { runWorkerCommand } from "./worker-command.runtime.js";
import { parseWorkerProcessResult, type WorkerProcessResult } from "./worker-process-protocol.js";
import { runWorkerProcess } from "./worker-process.js";
import { createWorkerRuntimeEnvironment, runWorkerDescriptor } from "./worker.runtime.js";

const managedRuntime = vi.hoisted(() => ({ backgroundCount: 0, close: vi.fn() }));

vi.mock("../agents/bash-process-registry.js", () => ({
  getActiveBackgroundExecSessionCount: () => managedRuntime.backgroundCount,
}));

vi.mock("./worker.runtime.js", () => ({
  runWorkerDescriptor: vi.fn(),
  createWorkerRuntimeEnvironment: vi.fn(),
}));

const descriptor = {
  version: 4,
  connectionEndpoint: { kind: "unix", socketPath: "/tmp/openclaw-worker/gateway.sock" },
  admission: {
    environmentId: "environment-1",
    credential: ["worker", "fixture", "value"].join("-"),
    sessionId: "session-1",
    ownerEpoch: 1,
    rpcSetVersion: WORKER_RPC_SET_VERSION,
    handshake: {
      bundleHash: "a".repeat(64),
      openclawVersion: "2026.7.12",
      protocolFeatures: [...WORKER_PROTOCOL_FEATURES],
    },
  },
  assignment: {
    agentId: "agent-1",
    operationalRunInstance: { instanceId: "instance-run-1", runId: "run-1" },
    agentRuntimeIdentityToken: "signed-runtime-token",
    runId: "run-1",
    turnId: "turn-1",
    prompt: "Inspect the workspace.",
    suppressPromptTranscript: false,
    workspaceDir: "/tmp/openclaw-worker/workspace",
    modelRef: { provider: "provider-1", model: "model-1" },
    inferenceOptions: { reasoning: "medium", maxTokens: 512 },
    initialMessages: [
      {
        role: "user",
        content: [{ type: "text", text: "Earlier context." }],
        timestamp: 1,
      },
    ],
    transcript: { baseLeafId: "leaf-7", nextSeq: 8 },
    liveEvents: { ackedSeq: 12, nextSeq: 13 },
    toolAuthority: { allowedToolNames: ["read", "exec"] },
  },
} satisfies WorkerLaunchDescriptor;

function commandInput() {
  const input = new PassThrough();
  input.end(JSON.stringify(descriptor));
  return input;
}

function lifetimeHarness() {
  const controller = new AbortController();
  let resolveStarted!: (started: boolean) => void;
  const started = new Promise<boolean>((resolve) => {
    resolveStarted = resolve;
  });
  const dispose = vi.fn();
  const reportConnectionFailure = vi.fn();
  const terminateOwnedTree = vi.fn();
  return {
    contract: {
      dispose,
      reportConnectionFailure,
      signal: controller.signal,
      started,
      terminateOwnedTree,
    },
    disconnectAfterStart: () => controller.abort(new Error("worker supervisor lifetime ended")),
    disconnectBeforeStart: () => resolveStarted(false),
    dispose,
    open: () => resolveStarted(true),
    terminateOwnedTree,
  };
}

function managedHarness() {
  const input = new PassThrough();
  const output = new PassThrough();
  const results: WorkerProcessResult[] = [];
  output.on("data", (chunk: Buffer) => {
    const result = parseWorkerProcessResult(JSON.parse(chunk.toString("utf8")));
    if (result) {
      results.push(result);
    }
  });
  const launch: WorkerLaunchDescriptor = structuredClone(descriptor);
  launch.assignment = {
    ...launch.assignment,
    workspaceDir: process.cwd(),
    permissionMode: "full",
    workerContainmentRoot: process.cwd(),
  };
  const send = (value: unknown) => input.write(`${JSON.stringify(value)}\n`);
  return {
    input,
    output,
    results,
    launch,
    send,
    turn: (value: WorkerLaunchDescriptor = launch) =>
      send({ type: "turn", turnId: value.assignment.turnId, descriptor: value }),
  };
}

describe("worker command lifetime gate", () => {
  beforeEach(() => {
    vi.mocked(runWorkerDescriptor).mockReset();
    vi.mocked(runWorkerDescriptor).mockResolvedValue({
      status: "completed",
      transcriptLeafId: null,
      transcriptNextSeq: 1,
    });
    managedRuntime.backgroundCount = 0;
    managedRuntime.close.mockReset();
    managedRuntime.close.mockResolvedValue(undefined);
    vi.mocked(createWorkerRuntimeEnvironment).mockReset();
    vi.mocked(createWorkerRuntimeEnvironment).mockResolvedValue({
      stateDir: "/tmp/openclaw-managed-worker-state",
      close: managedRuntime.close,
    });
  });

  it("keeps the ordinary worker command path ungated", async () => {
    const output = new PassThrough();
    const chunks: Buffer[] = [];
    output.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));

    await runWorkerCommand({ input: commandInput(), output });

    expect(runWorkerDescriptor).toHaveBeenCalledOnce();
    expect(JSON.parse(Buffer.concat(chunks).toString("utf8"))).toMatchObject({
      status: "completed",
    });
  });

  it("keeps worker process stdout valid JSON when runtime diagnostics are emitted", async () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const originalConsole = globalThis.console;
    const previousLogging = { ...loggingState };
    const originalStreams = {
      stdin: Object.getOwnPropertyDescriptor(process, "stdin")!,
      stdout: Object.getOwnPropertyDescriptor(process, "stdout")!,
      stderr: Object.getOwnPropertyDescriptor(process, "stderr")!,
    };
    Object.defineProperties(process, {
      stdin: { configurable: true, value: commandInput() },
      stdout: { configurable: true, value: stdout },
      stderr: { configurable: true, value: stderr },
    });
    globalThis.console = new Console({ stdout, stderr });
    loggingState.consolePatched = false;
    loggingState.forceConsoleToStderr = false;
    loggingState.rawConsole = null;
    loggingState.streamErrorHandlersInstalled = false;
    setLoggerOverride({ level: "silent", consoleLevel: "info", consoleStyle: "compact" });
    vi.mocked(runWorkerDescriptor).mockImplementationOnce(async () => {
      createSubsystemLogger("state/db").info("worker state diagnostic");
      return { status: "completed", transcriptLeafId: null, transcriptNextSeq: 1 };
    });
    let output = "";
    let diagnostics = "";
    try {
      await runWorkerProcess();
      output = String(stdout.read() ?? "");
      diagnostics = String(stderr.read() ?? "");
    } finally {
      Object.defineProperties(process, originalStreams);
      globalThis.console = originalConsole;
      Object.assign(loggingState, previousLogging);
      stdout.destroy();
      stderr.destroy();
    }

    expect(JSON.parse(output)).toEqual({
      status: "completed",
      transcriptLeafId: null,
      transcriptNextSeq: 1,
    });
    expect(diagnostics).toContain("worker state diagnostic");
  });

  it("passes the build-composed Browser runtime into the worker boundary", async () => {
    const output = new PassThrough();
    const browserRuntime = {
      createAttachedBrowserToolRuntime: vi.fn(),
    } as unknown as WorkerBrowserRuntime;

    await runWorkerCommand({ input: commandInput(), output, browserRuntime });

    expect(runWorkerDescriptor).toHaveBeenCalledWith(
      descriptor,
      expect.objectContaining({ browserRuntime }),
    );
  });

  it("does not enter the worker runtime before the explicit start message", async () => {
    const output = new PassThrough();
    const lifetime = lifetimeHarness();
    const running = runWorkerCommand({
      input: commandInput(),
      output,
      lifetime: lifetime.contract,
    });

    await new Promise((resolve) => {
      setImmediate(resolve);
    });
    expect(runWorkerDescriptor).not.toHaveBeenCalled();
    lifetime.open();

    await running;
    expect(runWorkerDescriptor).toHaveBeenCalledOnce();
    expect(lifetime.terminateOwnedTree).not.toHaveBeenCalled();
    expect(lifetime.dispose).toHaveBeenCalledOnce();
  });

  it("exits without starting when IPC disconnects before the start message", async () => {
    const output = new PassThrough();
    const lifetime = lifetimeHarness();
    const running = runWorkerCommand({
      input: commandInput(),
      output,
      lifetime: lifetime.contract,
    });

    lifetime.disconnectBeforeStart();

    await running;
    expect(runWorkerDescriptor).not.toHaveBeenCalled();
    expect(lifetime.terminateOwnedTree).not.toHaveBeenCalled();
    expect(lifetime.dispose).toHaveBeenCalledOnce();
  });

  it("aborts the real worker path and terminates its owned tree on IPC disconnect", async () => {
    const output = new PassThrough();
    let runtimeSignal: AbortSignal | undefined;
    vi.mocked(runWorkerDescriptor).mockImplementation(async (_descriptor, options) => {
      const signal = options?.signal;
      if (!signal) {
        throw new Error("expected worker lifetime abort signal");
      }
      runtimeSignal = signal;
      return await new Promise<never>((_, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            const reason = signal.reason;
            reject(reason instanceof Error ? reason : new Error("worker interrupted"));
          },
          { once: true },
        );
      });
    });
    const lifetime = lifetimeHarness();
    lifetime.terminateOwnedTree.mockImplementation(() => {
      expect(runtimeSignal?.aborted).toBe(true);
    });
    const running = runWorkerCommand({
      input: commandInput(),
      output,
      lifetime: lifetime.contract,
    });
    lifetime.open();
    await vi.waitFor(() => expect(runWorkerDescriptor).toHaveBeenCalledOnce());

    lifetime.disconnectAfterStart();

    await expect(running).rejects.toThrow("worker supervisor lifetime ended");
    expect(lifetime.terminateOwnedTree).toHaveBeenCalledOnce();
    expect(lifetime.dispose).toHaveBeenCalledOnce();
  });

  it("retains state across turns and cancels only the exact active turn", async () => {
    const harness = managedHarness();
    const lifetime = lifetimeHarness();
    managedRuntime.backgroundCount = 1;
    const secondStarted = createDeferred<AbortSignal>();
    vi.mocked(runWorkerDescriptor)
      .mockImplementationOnce(async () => ({
        status: "completed",
        transcriptLeafId: "first-leaf",
        transcriptNextSeq: 2,
      }))
      .mockImplementationOnce(async (_launch, options) => {
        const signal = options!.signal!;
        secondStarted.resolve(signal);
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
        managedRuntime.backgroundCount = 0;
        return {
          status: "failed",
          reason: "turn-failed",
          transcriptLeafId: "second-leaf",
          transcriptNextSeq: 3,
        };
      });
    const running = runWorkerCommand({ ...harness, managed: true, lifetime: lifetime.contract });
    lifetime.open();
    harness.turn();
    await vi.waitFor(() => expect(harness.results).toHaveLength(1));
    expect(harness.results[0]).toMatchObject({ turnId: "turn-1", retainWorker: true });
    expect(lifetime.dispose).not.toHaveBeenCalled();

    const next = structuredClone(harness.launch);
    next.assignment.turnId = "turn-2";
    next.assignment.runId = "run-2";
    next.assignment.operationalRunInstance = { instanceId: "instance-run-2", runId: "run-2" };
    harness.turn(next);
    const secondSignal = await secondStarted.promise;
    harness.send({ type: "cancel", turnId: "turn-1" });
    expect(secondSignal.aborted).toBe(false);
    harness.send({ type: "cancel", turnId: "turn-2" });
    await running;

    expect(harness.results[1]).toMatchObject({
      turnId: "turn-2",
      result: { status: "failed", reason: "turn-failed" },
      retainWorker: false,
    });
    expect(createWorkerRuntimeEnvironment).toHaveBeenCalledOnce();
    expect(
      vi.mocked(runWorkerDescriptor).mock.calls.map(([, options]) => options?.environmentStateDir),
    ).toEqual(["/tmp/openclaw-managed-worker-state", "/tmp/openclaw-managed-worker-state"]);
    expect(managedRuntime.close).toHaveBeenCalledOnce();
    expect(lifetime.dispose).toHaveBeenCalledOnce();
  });

  it("closes a retained environment when the managed input ends", async () => {
    const harness = managedHarness();
    managedRuntime.backgroundCount = 1;
    const running = runWorkerCommand({ ...harness, managed: true });
    harness.turn();
    await vi.waitFor(() => expect(harness.results).toHaveLength(1));
    harness.input.end();
    await running;
    expect(managedRuntime.close).toHaveBeenCalledOnce();
  });

  it.each(["owner", "output"] as const)(
    "closes state when %s ends during a pending result write",
    async (ending) => {
      const harness = managedHarness();
      const writing = createDeferred<(error?: Error | null) => void>();
      const output = new Writable({
        write: (_chunk, _encoding, callback) => {
          writing.resolve(callback);
        },
      });
      managedRuntime.backgroundCount = 1;
      const running = runWorkerCommand({ ...harness, output, managed: true });
      harness.turn();
      const completeWrite = await writing.promise;
      if (ending === "owner") {
        harness.input.end();
        await running;
        completeWrite();
      } else {
        const rejected = expect(running).rejects.toThrow("fixture result output failed");
        completeWrite(new Error("fixture result output failed"));
        await rejected;
      }
      expect(managedRuntime.close).toHaveBeenCalledOnce();
    },
  );

  it.each([
    "duplicate",
    "environment",
    "session",
    "epoch",
    "agent",
    "permission",
    "workspace",
    "containment",
  ] as const)("refuses a retained worker's %s identity change before admission", async (change) => {
    const harness = managedHarness();
    managedRuntime.backgroundCount = 1;
    const running = runWorkerCommand({ ...harness, managed: true });
    harness.turn();
    await vi.waitFor(() => expect(harness.results).toHaveLength(1));
    const next = structuredClone(harness.launch);
    if (change !== "duplicate") {
      next.assignment.turnId = "turn-2";
    }
    if (change === "environment") {
      next.admission.environmentId = "environment-2";
    }
    if (change === "session") {
      next.admission.sessionId = "session-2";
    }
    if (change === "epoch") {
      next.admission.ownerEpoch = 2;
    }
    if (change === "agent") {
      next.assignment.agentId = "agent-2";
    }
    if (change === "permission") {
      next.assignment.permissionMode = "read-only";
    }
    if (change === "workspace") {
      next.assignment.workspaceDir = path.dirname(process.cwd());
    }
    if (change === "containment") {
      next.assignment.workerContainmentRoot = path.dirname(process.cwd());
    }
    const rejected = expect(running).rejects.toThrow(
      change === "duplicate" ? "already executed" : "binding changed",
    );
    harness.turn(next);
    await rejected;
    expect(runWorkerDescriptor).toHaveBeenCalledOnce();
    expect(managedRuntime.close).toHaveBeenCalledOnce();
  });

  it("rejects concurrent turns and aborts the admitted turn before closing state", async () => {
    const harness = managedHarness();
    const started = createDeferred<AbortSignal>();
    vi.mocked(runWorkerDescriptor).mockImplementationOnce(async (_launch, options) => {
      const signal = options!.signal!;
      started.resolve(signal);
      await new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
      return { status: "completed", transcriptLeafId: null, transcriptNextSeq: 1 };
    });
    const running = runWorkerCommand({ ...harness, managed: true });
    harness.turn();
    const signal = await started.promise;
    const rejected = expect(running).rejects.toThrow("already active");
    const next = structuredClone(harness.launch);
    next.assignment.turnId = "turn-2";
    harness.turn(next);
    await rejected;
    expect(signal.aborted).toBe(true);
    expect(harness.results).toEqual([]);
    expect(managedRuntime.close).toHaveBeenCalledOnce();
  });

  it("bounds an unterminated managed input line before attempting admission", async () => {
    const harness = managedHarness();
    const running = runWorkerCommand({ ...harness, managed: true });
    const rejected = expect(running).rejects.toThrow("exceeds the protocol payload limit");
    harness.input.write(Buffer.alloc(WORKER_PROTOCOL_MAX_INFERENCE_PAYLOAD_BYTES + 1, 120));
    await rejected;
    expect(runWorkerDescriptor).not.toHaveBeenCalled();
    expect(createWorkerRuntimeEnvironment).not.toHaveBeenCalled();
  });
});
