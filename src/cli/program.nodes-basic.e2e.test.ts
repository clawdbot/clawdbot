import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createIosNodeListResponse } from "./program.nodes-test-helpers.js";
import { callGateway, installBaseProgramMocks, runtime } from "./program.test-mocks.js";

installBaseProgramMocks();

let registerNodesCli: typeof import("./nodes-cli.js").registerNodesCli;

function formatRuntimeLogCallArg(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  if (value == null) {
    return "";
  }
  try {
    return JSON.stringify(value);
  } catch {
    return "[unserializable]";
  }
}

describe("cli program (nodes basics)", () => {
  let program: Command;

  function createProgram() {
    const next = new Command();
    next.exitOverride();
    registerNodesCli(next);
    return next;
  }

  async function runProgram(argv: string[]) {
    runtime.log.mockClear();
    await program.parseAsync(argv, { from: "user" });
  }

  function getRuntimeOutput() {
    return runtime.log.mock.calls.map((c) => formatRuntimeLogCallArg(c[0])).join("\n");
  }

  function mockGatewayWithIosNodeListAnd(method: "node.describe" | "node.invoke", result: unknown) {
    callGateway.mockImplementation(async (...args: unknown[]) => {
      const opts = (args[0] ?? {}) as { method?: string };
      if (opts.method === "node.list") {
        return createIosNodeListResponse();
      }
      if (opts.method === method) {
        return result;
      }
      return { ok: true };
    });
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    ({ registerNodesCli } = await import("./nodes-cli.js"));
    program = createProgram();
  });

  it("runs nodes list --connected and filters to connected nodes", async () => {
    const now = Date.now();
    callGateway.mockImplementation(async (...args: unknown[]) => {
      const opts = (args[0] ?? {}) as { method?: string };
      if (opts.method === "node.pair.list") {
        return {
          pending: [],
          paired: [
            {
              nodeId: "n1",
              displayName: "One",
              remoteIp: "10.0.0.1",
              lastConnectedAtMs: now - 1_000,
            },
            {
              nodeId: "n2",
              displayName: "Two",
              remoteIp: "10.0.0.2",
              lastConnectedAtMs: now - 1_000,
            },
          ],
        };
      }
      if (opts.method === "node.list") {
        return {
          nodes: [
            { nodeId: "n1", connected: true },
            { nodeId: "n2", connected: false },
          ],
        };
      }
      return { ok: true };
    });
    await runProgram(["nodes", "list", "--connected"]);

    expect(callGateway).toHaveBeenCalledWith(expect.objectContaining({ method: "node.list" }));
    const output = getRuntimeOutput();
    expect(output).toContain("One");
    expect(output).not.toContain("Two");
  });

  it("runs nodes status --last-connected and filters by age", async () => {
    const now = Date.now();
    callGateway.mockImplementation(async (...args: unknown[]) => {
      const opts = (args[0] ?? {}) as { method?: string };
      if (opts.method === "node.list") {
        return {
          ts: now,
          nodes: [
            { nodeId: "n1", displayName: "One", connected: false },
            { nodeId: "n2", displayName: "Two", connected: false },
          ],
        };
      }
      if (opts.method === "node.pair.list") {
        return {
          pending: [],
          paired: [
            { nodeId: "n1", lastConnectedAtMs: now - 1_000 },
            { nodeId: "n2", lastConnectedAtMs: now - 2 * 24 * 60 * 60 * 1000 },
          ],
        };
      }
      return { ok: true };
    });
    await runProgram(["nodes", "status", "--last-connected", "24h"]);

    expect(callGateway).toHaveBeenCalledWith(expect.objectContaining({ method: "node.pair.list" }));
    const output = getRuntimeOutput();
    expect(output).toContain("One");
    expect(output).not.toContain("Two");
  });

  it.each([
    {
      label: "paired node details",
      node: {
        nodeId: "ios-node",
        displayName: "iOS Node",
        remoteIp: "192.168.0.88",
        deviceFamily: "iPad",
        modelIdentifier: "iPad16,6",
        caps: ["canvas", "camera"],
        paired: true,
        connected: true,
      },
      expectedOutput: [
        "Known: 1 · Paired: 1 · Connected: 1",
        "iOS Node",
        "Detail",
        "device: iPad",
        "hw: iPad16,6",
        "Status",
        "paired",
        "Caps",
        "camera",
        "canvas",
      ],
    },
    {
      label: "unpaired node details",
      node: {
        nodeId: "android-node",
        displayName: "Peter's Tab S10 Ultra",
        remoteIp: "192.168.0.99",
        deviceFamily: "Android",
        modelIdentifier: "samsung SM-X926B",
        caps: ["canvas", "camera"],
        paired: false,
        connected: true,
      },
      expectedOutput: [
        "Known: 1 · Paired: 0 · Connected: 1",
        "Peter's Tab",
        "S10 Ultra",
        "Detail",
        "device: Android",
        "hw: samsung",
        "SM-X926B",
        "Status",
        "unpaired",
        "connected",
        "Caps",
        "camera",
        "canvas",
      ],
    },
  ])("runs nodes status and renders $label", async ({ node, expectedOutput }) => {
    callGateway.mockResolvedValue({
      ts: Date.now(),
      nodes: [node],
    });
    await runProgram(["nodes", "status"]);

    expect(callGateway).toHaveBeenCalledWith(
      expect.objectContaining({ method: "node.list", params: {} }),
    );

    const output = getRuntimeOutput();
    for (const expected of expectedOutput) {
      expect(output).toContain(expected);
    }
  });

  it("runs nodes describe and calls node.describe", async () => {
    mockGatewayWithIosNodeListAnd("node.describe", {
      ts: Date.now(),
      nodeId: "ios-node",
      displayName: "iOS Node",
      caps: ["canvas", "camera"],
      commands: ["canvas.eval", "canvas.snapshot", "camera.snap"],
      connected: true,
    });

    await runProgram(["nodes", "describe", "--node", "ios-node"]);

    expect(callGateway).toHaveBeenCalledWith(
      expect.objectContaining({ method: "node.list", params: {} }),
    );
    expect(callGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "node.describe",
        params: { nodeId: "ios-node" },
      }),
    );

    const out = getRuntimeOutput();
    expect(out).toContain("Commands");
    expect(out).toContain("canvas.eval");
  });

  it("runs nodes approve and calls node.pair.approve", async () => {
    callGateway.mockResolvedValue({
      requestId: "r1",
      node: { nodeId: "n1", token: "t1" },
    });
    await runProgram(["nodes", "approve", "r1"]);
    expect(callGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "node.pair.approve",
        params: { requestId: "r1" },
      }),
    );
  });

  it("runs nodes invoke and calls node.invoke", async () => {
    mockGatewayWithIosNodeListAnd("node.invoke", {
      ok: true,
      nodeId: "ios-node",
      command: "canvas.eval",
      payload: { result: "ok" },
    });

    await runProgram([
      "nodes",
      "invoke",
      "--node",
      "ios-node",
      "--command",
      "canvas.eval",
      "--params",
      '{"javaScript":"1+1"}',
    ]);

    expect(callGateway).toHaveBeenCalledWith(
      expect.objectContaining({ method: "node.list", params: {} }),
    );
    expect(callGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "node.invoke",
        params: {
          nodeId: "ios-node",
          command: "canvas.eval",
          params: { javaScript: "1+1" },
          timeoutMs: 15000,
          idempotencyKey: "idem-test",
        },
      }),
    );
  });
});
