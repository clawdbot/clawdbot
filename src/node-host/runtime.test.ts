import { beforeEach, describe, expect, it, vi } from "vitest";
import { NODE_DEVICE_APPS_COMMAND } from "../infra/node-commands.js";
import type { OpenClawPluginNodeHostCommandIo } from "../plugins/types.js";
import { NODE_DESKTOP_STREAM_COMMAND } from "../shared/node-desktop-stream.js";
import type { NodeHostClient } from "./client.js";
import { listRegisteredNodeHostCapsAndCommands } from "./plugin-node-host.js";
import { prepareNodeHostRuntime } from "./runtime.js";

const mocks = vi.hoisted(() => {
  const closeMcp = vi.fn(async () => undefined);
  return {
    closeMcp,
    closeWorkerSupervisor: vi.fn(async () => undefined),
    handleInvoke: vi.fn(async () => undefined),
    progressStartHeartbeats: vi.fn(),
    progressWrite: vi.fn(async () => undefined),
    startMcp: vi.fn(async (_servers: unknown, _deps?: { signal?: AbortSignal }) => ({
      configuredServerCount: 0,
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

vi.mock("./node-worker-supervisor.js", () => ({
  createNodeWorkerSupervisor: vi.fn(() => ({ close: mocks.closeWorkerSupervisor })),
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
});

async function startRuntime() {
  const prepared = await prepareNodeHostRuntime({
    config: { nodeHost: { skills: { enabled: false } } },
    env: { PATH: "/usr/bin" },
    enableAgentRuns: true,
  });
  return prepared.start({
    client: { request: vi.fn(async () => ({ bins: [] })) } as unknown as NodeHostClient,
  });
}

function holdInvoke() {
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
      configuredServerCount: 0,
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
