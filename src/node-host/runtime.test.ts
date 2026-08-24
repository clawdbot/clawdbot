import { beforeEach, describe, expect, it, vi } from "vitest";
import { NODE_DEVICE_APPS_COMMAND } from "../infra/node-commands.js";
import type { OpenClawPluginNodeHostCommandIo } from "../plugins/types.js";
import { NODE_DESKTOP_STREAM_COMMAND } from "../shared/node-desktop-stream.js";
import type { NodeHostClient } from "./client.js";
import { createNodeWorkerSupervisor } from "./node-worker-supervisor.js";
import { listRegisteredNodeHostCapsAndCommands } from "./plugin-node-host.js";
import { prepareNodeHostRuntime } from "./runtime.js";

const mocks = vi.hoisted(() => {
  const closeMcp = vi.fn(async () => undefined);
  return {
    closeMcp,
    closeWorkerSupervisor: vi.fn(async () => undefined),
    initializeWorkerSupervisor: vi.fn(async () => undefined),
    resolveContainerEngine: vi.fn(async (_options?: { env?: NodeJS.ProcessEnv }) => ({
      id: "docker" as const,
      command: "docker",
      target: "e".repeat(64),
    })),
    handleInvoke: vi.fn(async () => undefined),
    progressStartHeartbeats: vi.fn(),
    progressWrite: vi.fn(async (_chunk: string) => undefined),
    startMcp: vi.fn(async (_servers: unknown, _deps?: { signal?: AbortSignal }) => ({
      descriptors: [],
      callMcpTool: vi.fn(),
      close: closeMcp,
    })),
  };
});

vi.mock("../infra/path-env.js", () => ({
  ensureOpenClawCliOnPath: vi.fn(),
}));

vi.mock("./invoke.js", () => ({
  handleInvoke: mocks.handleInvoke,
}));

vi.mock("./mcp.js", () => ({
  startNodeHostMcpManager: mocks.startMcp,
}));

vi.mock("./node-invoke-progress.js", () => ({
  createNodeInvokeProgressWriter: vi.fn(() => ({
    startHeartbeats: mocks.progressStartHeartbeats,
    write: mocks.progressWrite,
    stop: vi.fn(),
    flush: vi.fn(async () => undefined),
  })),
}));

vi.mock("./node-worker-container-engine.js", () => ({
  resolveNodeWorkerContainerEngine: mocks.resolveContainerEngine,
}));

vi.mock("./node-worker-supervisor.js", () => ({
  createNodeWorkerSupervisor: vi.fn(() => ({
    initialize: mocks.initializeWorkerSupervisor,
    close: mocks.closeWorkerSupervisor,
  })),
}));

vi.mock("./node-worker-workspace.js", () => ({
  NodeWorkerWorkspaceRuntime: class {
    readonly exec = vi.fn();
  },
}));

vi.mock("./plugin-node-host.js", () => ({
  ensureNodeHostPluginRegistry: vi.fn(async () => undefined),
  isRegisteredNodeHostCommandDuplex: vi.fn((command: string) => command === "test.duplex"),
  listRegisteredNodeHostCapsAndCommands: vi.fn(() => ({
    caps: ["terminal"],
    commands: ["test.duplex"],
    nodePluginTools: [],
  })),
}));

vi.mock("./skills.js", () => ({
  scanNodeHostedSkills: vi.fn(() => []),
}));

const frame = {
  id: "invoke-1",
  nodeId: "node-1",
  command: "test.duplex",
  paramsJSON: null,
  timeoutMs: 0,
  idempotencyKey: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.closeMcp.mockResolvedValue(undefined);
  mocks.closeWorkerSupervisor.mockResolvedValue(undefined);
  mocks.initializeWorkerSupervisor.mockResolvedValue(undefined);
});

async function startRuntime() {
  const prepared = await prepareNodeHostRuntime({
    config: { nodeHost: { skills: { enabled: false }, workerRuns: { enabled: true } } },
    env: { PATH: "/usr/bin" },
    enableAgentRuns: true,
    enableWorkerRuns: true,
  });
  return prepared.start({
    client: { request: vi.fn(async () => ({ bins: [] })) } as unknown as NodeHostClient,
  });
}

function holdInvoke(onCommand?: (io: OpenClawPluginNodeHostCommandIo) => void) {
  let io: OpenClawPluginNodeHostCommandIo | undefined;
  let signal: AbortSignal | undefined;
  let release: (() => void) | undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  mocks.handleInvoke.mockImplementationOnce(async (...args: unknown[]) => {
    const runtime = args[4] as {
      pluginCommandIo?: OpenClawPluginNodeHostCommandIo;
      signal?: AbortSignal;
    };
    io = runtime.pluginCommandIo;
    signal = runtime.signal;
    if (io) {
      onCommand?.(io);
    }
    await held;
  });
  return {
    get io() {
      return io;
    },
    get signal() {
      return signal;
    },
    release: () => release?.(),
  };
}

describe("node-host worker manifest", () => {
  it("allows environment-managed processes to force worker hosting without durable config", async () => {
    const prepared = await prepareNodeHostRuntime({
      config: { nodeHost: { skills: { enabled: false }, workerRuns: { enabled: false } } },
      env: { PATH: "/usr/bin" },
      enableWorkerRuns: true,
      forceWorkerRuns: true,
    });

    expect(prepared.workerHostingEnabled).toBe(true);
  });

  it("keeps local consent separate from connection metadata", async () => {
    const prepared = await prepareNodeHostRuntime({
      config: { nodeHost: { skills: { enabled: false }, workerRuns: { enabled: true } } },
      env: { PATH: "/usr/bin" },
      enableWorkerRuns: true,
    });

    expect(prepared.workerHostingEnabled).toBe(true);
    expect(prepared.manifest).not.toHaveProperty("workerRuns");
    expect(mocks.resolveContainerEngine).not.toHaveBeenCalled();
  });

  it("disables container-isolated hosting and records why when no engine is usable", async () => {
    const reason =
      "Container-isolated node workers require Docker or Podman; install and start an engine.";
    mocks.resolveContainerEngine.mockRejectedValueOnce(new Error(reason));

    const prepared = await prepareNodeHostRuntime({
      config: {
        nodeHost: {
          skills: { enabled: false },
          workerRuns: { enabled: true, isolation: "container" },
        },
      },
      env: { PATH: "/usr/bin" },
      enableWorkerRuns: true,
    });

    expect(prepared.workerHostingEnabled).toBe(false);
    expect(prepared.workerHostingDisabledReason).toBe(reason);
    const runtime = prepared.start({
      client: { request: vi.fn(async () => ({})) } as unknown as NodeHostClient,
    });
    expect(createNodeWorkerSupervisor).not.toHaveBeenCalled();
    await runtime.close();
  });

  it("disables container-isolated hosting on Windows before probing or advertising an engine", async () => {
    const prepared = await prepareNodeHostRuntime({
      config: {
        nodeHost: {
          skills: { enabled: false },
          workerRuns: { enabled: true, isolation: "container" },
        },
      },
      env: { PATH: "/usr/bin" },
      enableWorkerRuns: true,
      platform: "win32",
    });

    expect(prepared.workerHostingEnabled).toBe(false);
    expect(prepared.workerHostingDisabledReason).toMatch(/windows.*(?:linux|macos)/iu);
    expect(mocks.resolveContainerEngine).not.toHaveBeenCalled();
    expect(createNodeWorkerSupervisor).not.toHaveBeenCalled();
    const runtime = prepared.start({
      client: { request: vi.fn(async () => ({})) } as unknown as NodeHostClient,
    });
    expect(createNodeWorkerSupervisor).not.toHaveBeenCalled();
    await runtime.close();
  });

  it("resolves the container engine once and passes its exact identity to the supervisor", async () => {
    mocks.initializeWorkerSupervisor.mockImplementationOnce(async () => {
      const options = vi.mocked(createNodeWorkerSupervisor).mock.calls[0]?.[0];
      options?.onCapacityChanged?.({ total: 3, available: 0 });
      options?.onCapacityChanged?.({ total: 3, available: 3 });
    });
    const prepared = await prepareNodeHostRuntime({
      config: {
        nodeHost: {
          skills: { enabled: false },
          workerRuns: {
            enabled: true,
            isolation: "container",
            containerImage: "registry.example/openclaw-worker:22",
          },
        },
      },
      env: { PATH: "/usr/bin" },
      enableWorkerRuns: true,
    });

    expect(prepared.workerHostingEnabled).toBe(true);
    expect(mocks.resolveContainerEngine).toHaveBeenCalledOnce();
    expect(mocks.initializeWorkerSupervisor).toHaveBeenCalledOnce();
    const onRunnerCapacityChanged = vi.fn();
    const runtime = prepared.start({
      client: { request: vi.fn(async () => ({})) } as unknown as NodeHostClient,
      onRunnerCapacityChanged,
    });
    expect(createNodeWorkerSupervisor).toHaveBeenCalledWith(
      expect.objectContaining({
        containerEngine: { id: "docker", command: "docker", target: "e".repeat(64) },
        containerImage: "registry.example/openclaw-worker:22",
      }),
    );
    expect(mocks.resolveContainerEngine).toHaveBeenCalledOnce();
    expect(mocks.initializeWorkerSupervisor).toHaveBeenCalledOnce();
    expect(onRunnerCapacityChanged).toHaveBeenCalledExactlyOnceWith({ total: 3, available: 3 });
    await runtime.close();
  });

  it("fails closed when container launch reconciliation cannot establish safe ownership", async () => {
    mocks.initializeWorkerSupervisor.mockRejectedValueOnce(new Error("orphan sweep failed"));

    const prepared = await prepareNodeHostRuntime({
      config: {
        nodeHost: {
          skills: { enabled: false },
          workerRuns: { enabled: true, isolation: "container" },
        },
      },
      env: { PATH: "/usr/bin" },
      enableWorkerRuns: true,
    });

    expect(prepared.workerHostingEnabled).toBe(false);
    expect(prepared.workerHostingDisabledReason).toContain("orphan sweep failed");
    expect(mocks.closeWorkerSupervisor).toHaveBeenCalledOnce();
    const onRunnerCapacityChanged = vi.fn();
    const runtime = prepared.start({
      client: { request: vi.fn(async () => ({})) } as unknown as NodeHostClient,
      onRunnerCapacityChanged,
    });
    expect(createNodeWorkerSupervisor).toHaveBeenCalledOnce();
    expect(onRunnerCapacityChanged).not.toHaveBeenCalled();
    await runtime.close();
    expect(mocks.closeWorkerSupervisor).toHaveBeenCalledOnce();
  });
});

describe("node-host invocation cancellation", () => {
  it("cancels ordinary node invocations", async () => {
    const held = holdInvoke();
    const runtime = await startRuntime();
    const invoking = runtime.invoke({ ...frame, command: "system.run" });
    await vi.waitFor(() => expect(held.signal).toBeDefined());

    runtime.cancel(frame.id);

    expect(held.signal?.aborted).toBe(true);
    expect(held.io).toBeUndefined();
    held.release();
    await invoking;
    await runtime.close();
  });

  it("cancels a superseded invocation without orphaning its replacement", async () => {
    const first = holdInvoke();
    const second = holdInvoke();
    const runtime = await startRuntime();
    const firstInvoke = runtime.invoke({ ...frame, command: "system.run" });
    await vi.waitFor(() => expect(first.signal).toBeDefined());

    const secondInvoke = runtime.invoke({ ...frame, command: "system.run" });
    await vi.waitFor(() => expect(second.signal).toBeDefined());

    expect(first.signal?.aborted).toBe(true);
    expect(second.signal?.aborted).toBe(false);

    first.release();
    await firstInvoke;
    expect(second.signal?.aborted).toBe(false);
    runtime.cancel(frame.id);

    expect(second.signal?.aborted).toBe(true);
    second.release();
    await secondInvoke;
    await runtime.close();
  });

  it("cancels every ordinary invocation when the gateway disconnects", async () => {
    const first = holdInvoke();
    const second = holdInvoke();
    const runtime = await startRuntime();
    const firstInvoke = runtime.invoke({ ...frame, command: "system.run" });
    const secondInvoke = runtime.invoke({
      ...frame,
      id: "invoke-2",
      command: "system.run",
    });
    await vi.waitFor(() => {
      expect(first.signal).toBeDefined();
      expect(second.signal).toBeDefined();
    });

    runtime.cancelAll();

    expect(first.signal?.aborted).toBe(true);
    expect(second.signal?.aborted).toBe(true);
    first.release();
    second.release();
    await Promise.all([firstInvoke, secondInvoke]);
    await runtime.close();
  });

  it("cancels ordinary invocations when the node runtime closes", async () => {
    const held = holdInvoke();
    const runtime = await startRuntime();
    const invoking = runtime.invoke({ ...frame, command: "system.run" });
    await vi.waitFor(() => expect(held.signal).toBeDefined());

    await runtime.close();

    expect(held.signal?.aborted).toBe(true);
    expect(mocks.closeWorkerSupervisor).toHaveBeenCalledOnce();
    held.release();
    await invoking;
  });

  it("retires MCP even when supervisor close fails", async () => {
    const supervisorError = new Error("supervisor close failed");
    mocks.closeWorkerSupervisor.mockRejectedValueOnce(supervisorError);
    const runtime = await startRuntime();

    await expect(runtime.close()).rejects.toBe(supervisorError);
    expect(mocks.closeWorkerSupervisor).toHaveBeenCalledOnce();
    expect(mocks.closeMcp).toHaveBeenCalledOnce();
  });

  it("completes supervisor retirement even when MCP close fails", async () => {
    const mcpError = new Error("MCP close failed");
    mocks.closeMcp.mockRejectedValueOnce(mcpError);
    const runtime = await startRuntime();

    await expect(runtime.close()).rejects.toBe(mcpError);
    expect(mocks.closeWorkerSupervisor).toHaveBeenCalledOnce();
    expect(mocks.closeMcp).toHaveBeenCalledOnce();
  });

  it("aggregates independent supervisor and MCP close failures in owner order", async () => {
    const supervisorError = new Error("supervisor close failed");
    const mcpError = new Error("MCP close failed");
    mocks.closeWorkerSupervisor.mockRejectedValueOnce(supervisorError);
    mocks.closeMcp.mockRejectedValueOnce(mcpError);
    const runtime = await startRuntime();

    const error = await runtime.close().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([supervisorError, mcpError]);
  });

  it("aborts MCP startup before waiting while supervisor retirement runs independently", async () => {
    let startupSignal: AbortSignal | undefined;
    let resolveStartup!: (manager: Awaited<ReturnType<typeof mocks.startMcp>>) => void;
    mocks.startMcp.mockImplementationOnce(async (_servers, deps) => {
      startupSignal = deps?.signal;
      return await new Promise((resolve) => {
        resolveStartup = resolve;
      });
    });
    const runtime = await startRuntime();

    const closing = runtime.close();
    expect(startupSignal?.aborted).toBe(true);
    await vi.waitFor(() => expect(mocks.closeWorkerSupervisor).toHaveBeenCalledOnce());
    resolveStartup({
      descriptors: [],
      callMcpTool: vi.fn(),
      close: mocks.closeMcp,
    });

    await closing;
    expect(mocks.closeMcp).toHaveBeenCalledOnce();
  });
});

describe("node-host desktop manifest", () => {
  it("advertises desktop.stream only when the node-local desktop is enabled", async () => {
    const disabled = await prepareNodeHostRuntime({
      config: {},
      env: { PATH: "/usr/bin" },
      platform: "linux",
    });
    expect(disabled.manifest.commands).not.toContain(NODE_DESKTOP_STREAM_COMMAND);

    const enabled = await prepareNodeHostRuntime({
      config: { desktop: { host: { enabled: true } } },
      env: { PATH: "/usr/bin" },
      platform: "linux",
    });
    expect(enabled.manifest.commands).toContain(NODE_DESKTOP_STREAM_COMMAND);
  });

  it("emits desktop statuses without control-channel heartbeats", async () => {
    const runtime = await startRuntime();
    await runtime.invoke({ ...frame, command: NODE_DESKTOP_STREAM_COMMAND });

    expect(mocks.progressStartHeartbeats).not.toHaveBeenCalled();
    const lastCall = mocks.handleInvoke.mock.calls.at(-1) as unknown[] | undefined;
    const invokeRuntime = lastCall?.[4] as
      | {
          emitProgress?: (text: string) => Promise<void>;
        }
      | undefined;
    await invokeRuntime?.emitProgress?.("attached\n");
    expect(mocks.progressWrite).toHaveBeenCalledWith("attached\n");
    await runtime.close();
  });
});

describe("node-host invoke input dispatch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("provides framed binary message IO to duplex plugin commands", async () => {
    const held = holdInvoke();
    const runtime = await startRuntime();
    const invoking = runtime.invoke(frame);

    try {
      await vi.waitFor(() => expect(held.io).toBeDefined());
      expect(held.io).toMatchObject({
        frames: {
          send: expect.any(Function),
          onMessage: expect.any(Function),
        },
      });
    } finally {
      held.release();
      await invoking;
      await runtime.close();
    }
  });

  it("announces framed readiness only after the plugin registers its message listener", async () => {
    const held = holdInvoke();
    const runtime = await startRuntime();
    const invoking = runtime.invoke(frame);

    try {
      await vi.waitFor(() => expect(held.io).toBeDefined());
      expect(mocks.progressWrite).not.toHaveBeenCalled();

      const unsubscribe = held.io?.frames?.onMessage(vi.fn());

      await vi.waitFor(() =>
        expect(mocks.progressWrite).toHaveBeenCalledWith(JSON.stringify({ v: 1, kind: "ready" })),
      );
      expect(unsubscribe).toEqual(expect.any(Function));
      unsubscribe?.();
    } finally {
      held.release();
      await invoking;
      await runtime.close();
    }
  });

  it("round-trips binary messages through an external-style duplex plugin command", async () => {
    const received = vi.fn();
    const pluginCommand = {
      command: "test.duplex",
      duplex: true,
      handle: (_paramsJSON: string | null, io: OpenClawPluginNodeHostCommandIo) => {
        io.frames?.onMessage((message) => {
          received(message);
          void io.frames?.send(message);
        });
      },
    };
    const held = holdInvoke((io) => pluginCommand.handle(frame.paramsJSON, io));
    const runtime = await startRuntime();
    const invoking = runtime.invoke(frame);

    try {
      await vi.waitFor(() => expect(mocks.progressWrite).toHaveBeenCalledOnce());
      runtime.handleInput(
        frame.id,
        0,
        JSON.stringify({
          v: 1,
          kind: "data",
          message: 0,
          index: 0,
          last: true,
          data: "AP8B",
        }),
      );

      await vi.waitFor(() => expect(mocks.progressWrite).toHaveBeenCalledTimes(2));
      expect(received).toHaveBeenCalledWith(Uint8Array.from([0, 255, 1]));
      expect(JSON.parse(mocks.progressWrite.mock.calls[1]?.[0] ?? "null")).toMatchObject({
        v: 1,
        kind: "data",
        message: 0,
        index: 0,
        last: true,
        data: "AP8B",
      });
    } finally {
      held.release();
      await invoking;
      await runtime.close();
    }
  });

  it("preserves binary message boundaries and fragments output below the transport limit", async () => {
    const held = holdInvoke();
    const runtime = await startRuntime();
    const invoking = runtime.invoke(frame);

    try {
      await vi.waitFor(() => expect(held.io?.frames).toBeDefined());
      const received = vi.fn();
      held.io?.frames?.onMessage(received);
      await vi.waitFor(() => expect(mocks.progressWrite).toHaveBeenCalledOnce());
      mocks.progressWrite.mockClear();

      const incoming = Uint8Array.from({ length: 20_000 }, (_, index) => index % 256);
      const incomingFragments = [
        incoming.slice(0, 8_192),
        incoming.slice(8_192, 16_384),
        incoming.slice(16_384),
      ];
      for (const [index, fragment] of incomingFragments.entries()) {
        runtime.handleInput(
          frame.id,
          index,
          JSON.stringify({
            v: 1,
            kind: "data",
            message: 0,
            index,
            last: index === incomingFragments.length - 1,
            data: Buffer.from(fragment).toString("base64"),
          }),
        );
      }
      runtime.handleInput(
        frame.id,
        incomingFragments.length,
        JSON.stringify({
          v: 1,
          kind: "data",
          message: 1,
          index: 0,
          last: true,
          data: Buffer.from([0, 255]).toString("base64"),
        }),
      );
      expect(received.mock.calls).toEqual([[incoming], [Uint8Array.from([0, 255])]]);

      const outgoing = Uint8Array.from({ length: 20_000 }, (_, index) => (index * 7) % 256);
      await Promise.all([
        held.io?.frames?.send(outgoing),
        held.io?.frames?.send(Uint8Array.from([4, 5, 6])),
      ]);

      const fragments = mocks.progressWrite.mock.calls.map(([value]) => {
        expect(Buffer.byteLength(value, "utf8")).toBeLessThan(16 * 1024);
        return JSON.parse(value) as {
          v: number;
          kind: string;
          message: number;
          index: number;
          last: boolean;
          data: string;
        };
      });
      expect(fragments.map(({ message }) => message)).toEqual([0, 0, 0, 1]);
      expect(fragments.map(({ index }) => index)).toEqual([0, 1, 2, 0]);
      expect(
        Buffer.concat(
          fragments
            .filter(({ message }) => message === 0)
            .map(({ data }) => Buffer.from(data, "base64")),
        ),
      ).toEqual(Buffer.from(outgoing));
      expect(Buffer.from(fragments[3]?.data ?? "", "base64")).toEqual(Buffer.from([4, 5, 6]));
    } finally {
      held.release();
      await invoking;
      await runtime.close();
    }
  });

  it.each(["cancel", "result"] as const)(
    "closes framed plugin IO after invocation %s",
    async (terminalState) => {
      const held = holdInvoke();
      const runtime = await startRuntime();
      const invoking = runtime.invoke(frame);

      try {
        await vi.waitFor(() => expect(held.io?.frames).toBeDefined());
        const received = vi.fn();
        held.io?.frames?.onMessage(received);
        await vi.waitFor(() => expect(mocks.progressWrite).toHaveBeenCalledOnce());

        if (terminalState === "cancel") {
          runtime.cancel(frame.id);
        } else {
          held.release();
          await invoking;
        }
        runtime.handleInput(
          frame.id,
          0,
          JSON.stringify({
            v: 1,
            kind: "data",
            message: 0,
            index: 0,
            last: true,
            data: "eA==",
          }),
        );

        expect(received).not.toHaveBeenCalled();
        await expect(held.io?.frames?.send(Uint8Array.from([1]))).rejects.toThrow(/closed/i);
      } finally {
        held.release();
        await invoking;
        await runtime.close();
      }
    },
  );

  it("aborts a framed plugin command on malformed input without throwing through the transport", async () => {
    const held = holdInvoke();
    const runtime = await startRuntime();
    const invoking = runtime.invoke(frame);

    try {
      await vi.waitFor(() => expect(held.io?.frames).toBeDefined());
      held.io?.frames?.onMessage(vi.fn());
      await vi.waitFor(() => expect(mocks.progressWrite).toHaveBeenCalledOnce());

      expect(() => runtime.handleInput(frame.id, 0, "not-json")).not.toThrow();
      expect(held.io?.signal.aborted).toBe(true);
      await expect(held.io?.frames?.send(Uint8Array.from([1]))).rejects.toThrow(/closed/i);
    } finally {
      held.release();
      await invoking;
      await runtime.close();
    }
  });

  it("aborts the invocation when its framed plugin message listener fails", async () => {
    const held = holdInvoke();
    const runtime = await startRuntime();
    const invoking = runtime.invoke(frame);

    try {
      await vi.waitFor(() => expect(held.io?.frames).toBeDefined());
      held.io?.frames?.onMessage(() => {
        throw new Error("plugin message rejected");
      });
      await vi.waitFor(() => expect(mocks.progressWrite).toHaveBeenCalledOnce());

      expect(() =>
        runtime.handleInput(
          frame.id,
          0,
          JSON.stringify({
            v: 1,
            kind: "data",
            message: 0,
            index: 0,
            last: true,
            data: "eA==",
          }),
        ),
      ).not.toThrow();
      expect(held.io?.signal.aborted).toBe(true);
      expect(held.io?.signal.reason).toEqual(
        expect.objectContaining({ message: "plugin message rejected" }),
      );
    } finally {
      held.release();
      await invoking;
      await runtime.close();
    }
  });

  it("buffers frames before the command registers input and flushes them in order", async () => {
    const held = holdInvoke();
    const runtime = await startRuntime();
    const invoking = runtime.invoke(frame);
    await vi.waitFor(() => expect(held.io).toBeDefined());

    runtime.handleInput(frame.id, 0, "first");
    runtime.handleInput(frame.id, 1, "second");
    const input = vi.fn();
    held.io?.onInput(input);
    expect(input.mock.calls).toEqual([["first"], ["second"]]);

    held.release();
    await invoking;
    await runtime.close();
  });

  it("drops duplicates while tolerating sequence gaps", async () => {
    const held = holdInvoke();
    const runtime = await startRuntime();
    const invoking = runtime.invoke(frame);
    await vi.waitFor(() => expect(held.io).toBeDefined());

    const input = vi.fn();
    held.io?.onInput(input);
    runtime.handleInput("unknown", 0, "unknown");
    runtime.handleInput(frame.id, 0, "first");
    runtime.handleInput(frame.id, 0, "duplicate");
    runtime.handleInput(frame.id, 2, "gap");
    runtime.handleInput(frame.id, 3, "next");
    expect(input.mock.calls).toEqual([["first"], ["gap"], ["next"]]);

    held.release();
    await invoking;
    await runtime.close();
  });

  it("aborts without delivering partial input when the pre-spawn buffer overflows", async () => {
    const held = holdInvoke();
    const runtime = await startRuntime();
    const invoking = runtime.invoke(frame);
    await vi.waitFor(() => expect(held.io).toBeDefined());
    const chunk = "x".repeat(16 * 1024 - 1);

    for (let seq = 0; seq < 5; seq += 1) {
      runtime.handleInput(frame.id, seq, `${seq}${chunk}`);
    }
    expect(held.io?.signal.aborted).toBe(true);
    const input = vi.fn();
    held.io?.onInput(input);
    expect(input).not.toHaveBeenCalled();
    runtime.handleInput(frame.id, 5, "continued");
    expect(input).not.toHaveBeenCalled();

    held.release();
    await invoking;
    await runtime.close();
  });
});

describe("node-host duplex capability selection", () => {
  it("advertises duplex plugin commands without enabling native agent runs", async () => {
    await prepareNodeHostRuntime({
      config: { nodeHost: { skills: { enabled: false } } },
      env: { PATH: "/usr/bin" },
      enableDuplexPluginCommands: true,
    });

    expect(listRegisteredNodeHostCapsAndCommands).toHaveBeenLastCalledWith(expect.anything(), {
      includeDuplex: true,
    });
  });
});

describe("installed application command advertisement", () => {
  it("advertises device.apps only when sharing is enabled on macOS", async () => {
    const disabled = await prepareNodeHostRuntime({
      config: { nodeHost: { skills: { enabled: false } } },
      env: { PATH: "/usr/bin" },
      platform: "darwin",
      installedAppsSharingEnabled: false,
    });
    const enabled = await prepareNodeHostRuntime({
      config: { nodeHost: { skills: { enabled: false } } },
      env: { PATH: "/usr/bin" },
      platform: "darwin",
      installedAppsSharingEnabled: true,
    });
    const nonDarwin = await prepareNodeHostRuntime({
      config: { nodeHost: { skills: { enabled: false } } },
      env: { PATH: "/usr/bin" },
      platform: "linux",
      installedAppsSharingEnabled: true,
    });

    expect(disabled.manifest.commands).not.toContain(NODE_DEVICE_APPS_COMMAND);
    expect(enabled.manifest.commands).toContain(NODE_DEVICE_APPS_COMMAND);
    expect(nonDarwin.manifest.commands).not.toContain(NODE_DEVICE_APPS_COMMAND);
  });
});
