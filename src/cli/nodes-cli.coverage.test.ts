// Nodes CLI coverage tests cover node command branches and output formatting.
import { Command } from "commander";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { registerNodesCli } from "./nodes-cli.js";

type NodeInvokeCall = {
  method?: string;
  params?: {
    idempotencyKey?: string;
    command?: string;
    params?: unknown;
    timeoutMs?: number;
  };
};

let lastNodeInvokeCall: NodeInvokeCall | null = null;

const callGateway = vi.fn(async (opts: NodeInvokeCall) => {
  if (opts.method === "node.list") {
    return {
      nodes: [
        {
          nodeId: "mac-1",
          displayName: "Mac",
          platform: "macos",
          caps: ["canvas"],
          connected: true,
          permissions: { screenRecording: true },
        },
      ],
    };
  }
  if (opts.method === "node.invoke") {
    lastNodeInvokeCall = opts;
    return {
      payload: {
        stdout: "",
        stderr: "",
        exitCode: 0,
        success: true,
        timedOut: false,
      },
    };
  }
  return { ok: true };
});

const randomIdempotencyKey = vi.fn(() => "rk_test");

const mocks = await vi.hoisted(async () => {
  const { createCliRuntimeMock } = await import("./test-runtime-mock.js");
  return createCliRuntimeMock(vi);
});

const { runtimeErrors, defaultRuntime } = mocks;

vi.mock("../gateway/call.js", () => ({
  callGateway: (opts: unknown) => callGateway(opts as NodeInvokeCall),
  randomIdempotencyKey: () => randomIdempotencyKey(),
}));

vi.mock("../runtime.js", async () => ({
  ...(await vi.importActual<typeof import("../runtime.js")>("../runtime.js")),
  defaultRuntime: mocks.defaultRuntime,
}));

describe("nodes-cli coverage", () => {
  const sharedProgram: Command = new Command();

  const withSuppressedStderr = async <T>(run: () => Promise<T>) => {
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((() => true) as typeof process.stderr.write);
    try {
      return await run();
    } finally {
      stderrSpy.mockRestore();
    }
  };

  const getNodeInvokeCall = () => {
    const last = lastNodeInvokeCall;
    if (!last) {
      throw new Error("expected node.invoke call");
    }
    return last;
  };

  const runNodesCommand = async (args: string[]) => {
    await sharedProgram.parseAsync(args, { from: "user" });
    return getNodeInvokeCall();
  };

  beforeAll(async () => {
    if (sharedProgram.commands.length > 0) {
      return;
    }
    sharedProgram.exitOverride();
    await registerNodesCli(sharedProgram);
  });

  beforeEach(() => {
    runtimeErrors.length = 0;
    callGateway.mockClear();
    randomIdempotencyKey.mockClear();
    defaultRuntime.log.mockClear();
    defaultRuntime.error.mockClear();
    defaultRuntime.writeStdout.mockClear();
    defaultRuntime.writeJson.mockClear();
    defaultRuntime.exit.mockClear();
    lastNodeInvokeCall = null;
  });

  it("does not register the removed run wrapper", async () => {
    await withSuppressedStderr(async () => {
      let error: { code?: unknown } | undefined;
      try {
        await sharedProgram.parseAsync(["nodes", "run", "--node", "mac-1"], { from: "user" });
      } catch (err) {
        error = err as { code?: unknown };
      }
      expect(error?.code).toBe("commander.unknownCommand");
    });
  });

  it("blocks system.run on nodes invoke", async () => {
    await expect(
      sharedProgram.parseAsync(["nodes", "invoke", "--node", "mac-1", "--command", "system.run"], {
        from: "user",
      }),
    ).rejects.toThrow("__exit__:1");
    expect(runtimeErrors.at(-1)).toContain('command "system.run" is reserved for shell execution');
  });

  it("invokes system.notify with provided fields", async () => {
    const invoke = await runNodesCommand([
      "nodes",
      "notify",
      "--node",
      "mac-1",
      "--title",
      "Ping",
      "--body",
      "Gateway ready",
      "--delivery",
      "overlay",
    ]);

    if (!invoke) {
      throw new Error("expected system.notify invocation");
    }
    expect(invoke.params?.command).toBe("system.notify");
    expect(invoke.params?.params).toEqual({
      title: "Ping",
      body: "Gateway ready",
      sound: undefined,
      priority: undefined,
      delivery: "overlay",
    });
  });

  it("invokes location.get with params", async () => {
    const invoke = await runNodesCommand([
      "nodes",
      "location",
      "get",
      "--node",
      "mac-1",
      "--accuracy",
      "precise",
      "--max-age",
      "1000",
      "--location-timeout",
      "5000",
      "--invoke-timeout",
      "6000",
    ]);

    if (!invoke) {
      throw new Error("expected location.get invocation");
    }
    expect(invoke.params?.command).toBe("location.get");
    expect(invoke.params?.params).toEqual({
      maxAgeMs: 1000,
      desiredAccuracy: "precise",
      timeoutMs: 5000,
    });
    expect(invoke.params?.timeoutMs).toBe(6000);
  });

  it.each([
    {
      args: ["nodes", "location", "get", "--node", "mac-1", "--max-age", "1000ms"],
      flag: "--max-age",
    },
    {
      args: ["nodes", "location", "get", "--node", "mac-1", "--location-timeout", "5s"],
      flag: "--location-timeout",
    },
    {
      args: ["nodes", "location", "get", "--node", "mac-1", "--invoke-timeout", "6s"],
      flag: "--invoke-timeout",
    },
    {
      args: ["nodes", "camera", "snap", "--node", "mac-1", "--max-width", "1024px"],
      flag: "--max-width",
    },
    {
      args: ["nodes", "camera", "snap", "--node", "mac-1", "--delay-ms", "20ms"],
      flag: "--delay-ms",
    },
    {
      args: ["nodes", "camera", "snap", "--node", "mac-1", "--invoke-timeout", "20s"],
      flag: "--invoke-timeout",
    },
    {
      args: ["nodes", "camera", "snap", "--node", "mac-1", "--quality", "0.8jpg"],
      flag: "--quality",
    },
    {
      args: ["nodes", "camera", "snap", "--node", "mac-1", "--quality", "1.1"],
      flag: "--quality",
    },
    {
      args: ["nodes", "camera", "clip", "--node", "mac-1", "--invoke-timeout", "90s"],
      flag: "--invoke-timeout",
    },
    {
      args: ["nodes", "screen", "record", "--node", "mac-1", "--screen", "1x"],
      flag: "--screen",
    },
    {
      args: ["nodes", "screen", "record", "--node", "mac-1", "--invoke-timeout", "120s"],
      flag: "--invoke-timeout",
    },
    {
      args: ["nodes", "screen", "record", "--node", "mac-1", "--fps", "10fps"],
      flag: "--fps",
    },
    {
      args: ["nodes", "screen", "record", "--node", "mac-1", "--fps", "0"],
      flag: "--fps",
    },
    {
      args: ["nodes", "notify", "--node", "mac-1", "--title", "Ping", "--invoke-timeout", "15s"],
      flag: "--invoke-timeout",
    },
    {
      args: [
        "nodes",
        "invoke",
        "--node",
        "mac-1",
        "--command",
        "canvas.eval",
        "--invoke-timeout",
        "15s",
      ],
      flag: "--invoke-timeout",
    },
  ])("rejects partial numeric option for $args", async ({ args, flag }) => {
    await expect(sharedProgram.parseAsync(args, { from: "user" })).rejects.toThrow("__exit__:1");
    expect(runtimeErrors.at(-1)).toContain(`${flag} must be`);
    expect(lastNodeInvokeCall).toBeNull();
  });
});
