import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { SkillBinTrustEntry } from "../infra/exec-approvals.js";
import { NODE_DEVICE_APPS_COMMAND } from "../infra/node-commands.js";
import type { OpenClawPluginNodeHostCommandIo } from "../plugins/types.js";
import { NODE_DESKTOP_STREAM_COMMAND } from "../shared/node-desktop-stream.js";
import { withEnvAsync } from "../test-utils/env.js";
import type { NodeHostClient } from "./client.js";
import type { SkillBinsProvider } from "./invoke.js";
import { listRegisteredNodeHostCapsAndCommands } from "./plugin-node-host.js";
import { prepareNodeHostRuntime } from "./runtime.js";

const mocks = vi.hoisted(() => {
  const closeMcp = vi.fn(async () => undefined);
  return {
    closeMcp,
    closeWorkerSupervisor: vi.fn(async () => undefined),
    initializeWorkerSupervisor: vi.fn(async () => undefined),
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

function createNodeHostClient(request: () => Promise<unknown>): NodeHostClient {
  return {
    async request<T>() {
      return (await request()) as T;
    },
  };
}

async function startRuntime(
  client: NodeHostClient = createNodeHostClient(async () => ({ bins: [] })),
) {
  const prepared = await prepareNodeHostRuntime({
    config: { nodeHost: { skills: { enabled: false }, workerRuns: { enabled: true } } },
    env: { PATH: "/usr/bin" },
    enableAgentRuns: true,
    enableWorkerRuns: true,
  });
  return prepared.start({ client });
}

type SkillBinsResponse = { bins: string[] };
type SkillBinsFixture = {
  requests: Array<ReturnType<typeof createDeferred<SkillBinsResponse>>>;
  observed: Map<string, SkillBinTrustEntry[]>;
  expected: SkillBinTrustEntry[];
  response: SkillBinsResponse;
  invoke: (id: string) => Promise<void>;
  expire: () => void;
  disconnect: () => void;
};

async function withSkillBinsRuntime(run: (fixture: SkillBinsFixture) => Promise<void>) {
  await withEnvAsync({ PATH: path.dirname(process.execPath) }, async () => {
    const requests: SkillBinsFixture["requests"] = [];
    const observed = new Map<string, SkillBinTrustEntry[]>();
    const invokes: Promise<void>[] = [];
    const name = path.basename(process.execPath);
    const response = { bins: [name] };
    const now = Date.now;
    let elapsed = 0;
    const runtime = await startRuntime(
      createNodeHostClient(() => {
        const request = createDeferred<SkillBinsResponse>();
        requests.push(request);
        return request.promise;
      }),
    );
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now() + elapsed);
    mocks.handleInvoke.mockImplementation(async (...args: unknown[]) => {
      const request = args[0] as typeof frame;
      const provider = args[2] as SkillBinsProvider;
      observed.set(request.id, await provider.current());
    });
    try {
      await run({
        requests,
        observed,
        expected: [{ name, resolvedPath: fs.realpathSync(process.execPath) }],
        response,
        invoke: (id) => {
          const pending = runtime.invoke({ ...frame, id, command: "system.run" });
          invokes.push(pending);
          return pending;
        },
        expire: () => {
          elapsed += 90_001;
        },
        disconnect: () => runtime.cancelAll(),
      });
    } finally {
      runtime.cancelAll();
      for (const request of requests) {
        request.resolve({ bins: [] });
      }
      await Promise.allSettled(invokes);
      try {
        await runtime.close();
      } finally {
        mocks.handleInvoke.mockReset();
        clock.mockRestore();
      }
    }
  });
}

async function primeSkillBins(fixture: SkillBinsFixture) {
  const pending = fixture.invoke("prime");
  await vi.waitFor(() => expect(fixture.requests).toHaveLength(1));
  expectDefined(fixture.requests[0], "initial skill refresh").resolve(fixture.response);
  await pending;
  expect(fixture.observed.get("prime")).toEqual(fixture.expected);
  fixture.expire();
}

describe("node-host skill-bin cache", () => {
  it.each(["cold", "expired"])(
    "shares a %s refresh and returns resolved binaries",
    async (phase) => {
      await withSkillBinsRuntime(async (fixture) => {
        if (phase === "expired") {
          await primeSkillBins(fixture);
        }
        const requestCount = fixture.requests.length + 1;
        const first = fixture.invoke("first");
        const second = fixture.invoke("second");
        await vi.waitFor(() => expect(fixture.requests).toHaveLength(requestCount));
        expectDefined(fixture.requests[requestCount - 1], "shared skill refresh").resolve(
          fixture.response,
        );
        await Promise.all([first, second]);
        await fixture.invoke("warm");
        for (const id of ["first", "second", "warm"]) {
          expect(fixture.observed.get(id)).toEqual(fixture.expected);
        }
        expect(fixture.requests).toHaveLength(requestCount);
      });
    },
  );

  it.each(["cold", "expired"])("shares a failed %s refresh and permits retry", async (phase) => {
    await withSkillBinsRuntime(async (fixture) => {
      if (phase === "expired") {
        await primeSkillBins(fixture);
      }
      const requestCount = fixture.requests.length + 1;
      const first = fixture.invoke("first");
      const second = fixture.invoke("second");
      await vi.waitFor(() => expect(fixture.requests).toHaveLength(requestCount));
      expectDefined(fixture.requests[requestCount - 1], "failed skill refresh").reject(
        new Error("Gateway unavailable"),
      );
      await Promise.all([first, second]);
      for (const id of ["first", "second"]) {
        expect(fixture.observed.get(id)).toEqual(phase === "expired" ? fixture.expected : []);
      }
      const retry = fixture.invoke("retry");
      await vi.waitFor(() => expect(fixture.requests).toHaveLength(requestCount + 1));
      expectDefined(fixture.requests[requestCount], "retried skill refresh").resolve(
        fixture.response,
      );
      await retry;
      expect(fixture.observed.get("retry")).toEqual(fixture.expected);
    });
  });

  it("keeps pending old-connection results out of the replacement cache", async () => {
    await withSkillBinsRuntime(async (fixture) => {
      const old = fixture.invoke("old");
      await vi.waitFor(() => expect(fixture.requests).toHaveLength(1));
      fixture.disconnect();
      const replacement = fixture.invoke("replacement");
      await vi.waitFor(() => expect(fixture.requests).toHaveLength(2));
      expectDefined(fixture.requests[0], "retired connection refresh").resolve(fixture.response);
      await old;
      expect(fixture.observed.has("replacement")).toBe(false);
      expectDefined(fixture.requests[1], "replacement connection refresh").resolve({ bins: [] });
      await replacement;
      await fixture.invoke("replacement-warm");
      expect(fixture.observed.get("replacement")).toEqual([]);
      expect(fixture.observed.get("replacement-warm")).toEqual([]);
      expect(fixture.requests).toHaveLength(2);
    });
  });
});

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

describe("node-host invocation cancellation", () => {
  it("does not admit a queued invocation after its connection is retired", async () => {
    const runtime = await startRuntime();
    const pending = runtime.invoke({ ...frame, command: "system.run" });
    runtime.cancelAll();
    await pending;
    expect(mocks.handleInvoke).not.toHaveBeenCalled();
    await runtime.close();
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
