import { beforeEach, describe, expect, it, vi } from "vitest";
import { NODE_DEVICE_APPS_COMMAND } from "../infra/node-commands.js";
import type { OpenClawPluginNodeHostCommandIo } from "../plugins/types.js";
import type { NodeHostClient } from "./client.js";
import { listRegisteredNodeHostCapsAndCommands } from "./plugin-node-host.js";
import { prepareNodeHostRuntime } from "./runtime.js";

const mocks = vi.hoisted(() => ({
  closeMcp: vi.fn(async () => undefined),
  handleInvoke: vi.fn(async () => undefined),
}));

vi.mock("../infra/path-env.js", () => ({
  ensureOpenClawCliOnPath: vi.fn(),
}));

vi.mock("./invoke.js", () => ({
  handleInvoke: mocks.handleInvoke,
}));

vi.mock("./mcp.js", () => ({
  startNodeHostMcpManager: vi.fn(async () => ({
    configuredServerCount: 0,
    descriptors: [],
    callMcpTool: vi.fn(),
    close: mocks.closeMcp,
  })),
}));

vi.mock("./node-invoke-progress.js", () => ({
  createNodeInvokeProgressWriter: vi.fn(() => ({
    startHeartbeats: vi.fn(),
    write: vi.fn(async () => undefined),
    stop: vi.fn(),
    flush: vi.fn(async () => undefined),
  })),
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
  beforeEach(() => {
    vi.clearAllMocks();
  });

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
    held.release();
    await invoking;
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
