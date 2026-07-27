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

const callGateway = vi.fn(async (opts: NodeInvokeCall): Promise<unknown> => {
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

  it("explains unknown nodes approve request ids with the current pending requests", async () => {
    callGateway.mockResolvedValueOnce({
      pending: [{ requestId: "current-request", nodeId: "n1", ts: Date.now() }],
      paired: [],
    });

    await expect(
      sharedProgram.parseAsync(
        [
          "nodes",
          "approve",
          "stale-request",
          "--url",
          "wss://gateway.example.test",
          "--token",
          "secret-token",
        ],
        { from: "user" },
      ),
    ).rejects.toThrow("__exit__:1");

    const output = runtimeErrors.join("\n");
    expect(output).toContain("Unknown node pairing requestId: stale-request");
    expect(output).toContain("Pending requestIds: current-request");
    expect(output).toContain("openclaw nodes pending");
    expect(output).toContain("Reuse the same connection options when rerunning: --url, --token.");
    expect(output).not.toContain("gateway.example.test");
    expect(output).not.toContain("secret-token");
    expect(output).not.toContain("nodes approve failed: Error:");
    expect(output).not.toContain("GatewayClientRequestError: unknown requestId");
    expect(callGateway.mock.calls.map(([call]) => call.method)).toEqual(["node.pair.list"]);
  });

  it("explains when a nodes approve request disappears after the preflight", async () => {
    callGateway
      .mockResolvedValueOnce({
        pending: [{ requestId: "expired-request", nodeId: "n1", ts: Date.now() }],
        paired: [],
      })
      .mockRejectedValueOnce(
        Object.assign(new Error("unknown requestId"), {
          name: "GatewayClientRequestError",
          gatewayCode: "INVALID_REQUEST",
        }),
      );

    await expect(
      sharedProgram.parseAsync(["nodes", "approve", "expired-request"], { from: "user" }),
    ).rejects.toThrow("__exit__:1");

    const output = runtimeErrors.join("\n");
    expect(output).toContain("Unknown node pairing requestId: expired-request");
    expect(output).not.toContain("No pending node pairing requests are currently visible.");
    expect(output).not.toContain("Pending requestIds:");
    expect(output).toContain("openclaw nodes pending");
    expect(output).not.toContain("GatewayClientRequestError: unknown requestId");
    expect(callGateway.mock.calls.map(([call]) => call.method)).toEqual([
      "node.pair.list",
      "node.pair.approve",
    ]);
  });

  it("still approves when the pairing preflight is unavailable", async () => {
    callGateway
      .mockRejectedValueOnce(new Error("pairing list unavailable"))
      .mockResolvedValueOnce({ approved: true });

    await sharedProgram.parseAsync(["nodes", "approve", "request-1"], { from: "user" });

    expect(callGateway.mock.calls.map(([call]) => call.method)).toEqual([
      "node.pair.list",
      "node.pair.approve",
    ]);
    expect(defaultRuntime.writeJson).toHaveBeenCalledWith({ approved: true });
  });

  it("blocks system.run on nodes invoke", async () => {
    await expect(
      sharedProgram.parseAsync(["nodes", "invoke", "--node", "mac-1", "--command", "system.run"], {
        from: "user",
      }),
    ).rejects.toThrow("__exit__:1");
    expect(runtimeErrors.at(-1)).toContain('command "system.run" is reserved for shell execution');
  });

  it("rejects malformed nodes invoke params before opening a gateway call", async () => {
    await expect(
      sharedProgram.parseAsync(
        ["nodes", "invoke", "--node", "mac-1", "--command", "canvas.eval", "--params", "not-json"],
        { from: "user" },
      ),
    ).rejects.toThrow("__exit__:1");

    expect(runtimeErrors.at(-1)).toContain("--params must be valid JSON.");
    expect(callGateway).not.toHaveBeenCalled();
    expect(lastNodeInvokeCall).toBeNull();
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
