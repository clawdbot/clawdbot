import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  WORKER_PROTOCOL_FEATURES,
  WORKER_RPC_SET_VERSION,
} from "../../packages/gateway-protocol/src/schema/worker-admission.js";
import type { WorkerBrowserRuntime } from "./browser-runtime.js";
import type { WorkerLaunchDescriptor } from "./launch-descriptor.js";
import { runWorkerCommand } from "./worker-command.runtime.js";
import { runWorkerDescriptor } from "./worker.runtime.js";

vi.mock("./worker.runtime.js", () => ({
  runWorkerDescriptor: vi.fn(),
}));

const descriptor = {
  version: 3,
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

describe("worker command lifetime gate", () => {
  beforeEach(() => {
    vi.mocked(runWorkerDescriptor).mockReset();
    vi.mocked(runWorkerDescriptor).mockResolvedValue({
      status: "completed",
      transcriptLeafId: null,
      transcriptNextSeq: 1,
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
});
