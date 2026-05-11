import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createIosNodeListResponse } from "./program.nodes-test-helpers.js";
import { callGateway, installBaseProgramMocks, runtime } from "./program.test-mocks.js";

installBaseProgramMocks();

let registerNodesCli: typeof import("./nodes-cli.js").registerNodesCli;

type GatewayCallRequest = {
  method?: string;
  params?: unknown;
};

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

  async function createProgram() {
    const next = new Command();
    next.exitOverride();
    await registerNodesCli(next);
    return next;
  }

  async function runProgram(argv: string[]) {
    runtime.log.mockClear();
    await program.parseAsync(argv, { from: "user" });
  }

  function getRuntimeOutput() {
    return runtime.log.mock.calls.map((c) => formatRuntimeLogCallArg(c[0])).join("\n");
  }

  function gatewayRequests(): GatewayCallRequest[] {
    return callGateway.mock.calls.map(([request]) => request as GatewayCallRequest);
  }

  function expectGatewayRequest(method: string, params?: unknown): void {
    const request = gatewayRequests().find((candidate) => candidate.method === method);
    expect(request?.method).toBe(method);
    if (arguments.length > 1) {
      expect(request?.params).toEqual(params);
    }
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
    program = await createProgram();
  });

  it("runs nodes list with the effective paired node view while preserving paired metadata", async () => {
    const now = Date.now();
    callGateway.mockImplementation(async (...args: unknown[]) => {
      const opts = (args[0] ?? {}) as { method?: string };
      if (opts.method === "node.pair.list") {
        return {
          pending: [{ requestId: "r1", nodeId: "pending-node", ts: now - 10_000 }],
          paired: [
            {
              nodeId: "paired-store",
              displayName: "Stale paired name",
              remoteIp: "10.0.0.1",
              token: "paired-token",
              lastConnectedAtMs: now - 5_000,
            },
            {
              nodeId: "pair-only",
              displayName: "Pair Only",
              token: "pair-only-token",
            },
          ],
        };
      }
      if (opts.method === "node.list") {
        return {
          nodes: [
            {
              nodeId: "paired-store",
              displayName: "Effective paired name",
              remoteIp: "10.0.0.2",
              connected: true,
              connectedAtMs: now - 1_000,
            },
            {
              nodeId: "catalog-only",
              displayName: "Catalog Only",
              remoteIp: "10.0.0.3",
              paired: true,
              connected: false,
            },
            {
              nodeId: "effective-only-unknown",
              displayName: "Effective Only Unknown",
              connected: true,
            },
            {
              nodeId: "unpaired-live",
              displayName: "Unpaired Live",
              paired: false,
              connected: true,
            },
          ],
        };
      }
      return { ok: true };
    });

    await runProgram(["nodes", "list", "--json"]);

    expectGatewayRequest("node.pair.list", {});
    expectGatewayRequest("node.list", {});
    const json = runtime.writeJson.mock.calls[0]?.[0] as {
      pending?: unknown[];
      paired?: Array<Record<string, unknown>>;
    };
    expect(json.pending).toEqual([{ requestId: "r1", nodeId: "pending-node", ts: now - 10_000 }]);
    expect(
      json.paired?.map((node) => ({
        nodeId: node.nodeId,
        displayName: node.displayName,
        remoteIp: node.remoteIp,
        lastConnectedAtMs: node.lastConnectedAtMs,
        connected: node.connected,
        paired: node.paired,
      })),
    ).toEqual([
      {
        nodeId: "paired-store",
        displayName: "Effective paired name",
        remoteIp: "10.0.0.2",
        lastConnectedAtMs: now - 5_000,
        connected: true,
        paired: undefined,
      },
      {
        nodeId: "catalog-only",
        displayName: "Catalog Only",
        remoteIp: "10.0.0.3",
        lastConnectedAtMs: undefined,
        connected: false,
        paired: true,
      },
      {
        nodeId: "pair-only",
        displayName: "Pair Only",
        remoteIp: undefined,
        lastConnectedAtMs: undefined,
        connected: undefined,
        paired: undefined,
      },
    ]);
    expect(JSON.stringify(json)).not.toContain("paired-token");
    expect(JSON.stringify(json)).not.toContain("pair-only-token");
    const output = getRuntimeOutput();
    expect(output).toContain("Pending: 1 · Paired: 3");
    expect(output).not.toContain("Effective Only Unknown");
    expect(output).not.toContain("unpaired-live");
  });

  it("runs unfiltered nodes list with pairing data when node.list is unavailable", async () => {
    callGateway.mockImplementation(async (...args: unknown[]) => {
      const opts = (args[0] ?? {}) as { method?: string };
      if (opts.method === "node.pair.list") {
        return {
          pending: [],
          paired: [
            {
              nodeId: "pairing-scoped",
              displayName: "Pairing Scoped",
              remoteIp: "10.0.0.9",
            },
          ],
        };
      }
      if (opts.method === "node.list") {
        throw new Error("unauthorized");
      }
      return { ok: true };
    });

    await runProgram(["nodes", "list"]);

    const output = getRuntimeOutput();
    expect(output).toContain("Pending: 0 · Paired: 1");
    expect(output).toContain("Pairing Scoped");
  });

  it("sanitizes untrusted nodes list table fields while preserving JSON values", async () => {
    const now = Date.now();
    callGateway.mockImplementation(async (...args: unknown[]) => {
      const opts = (args[0] ?? {}) as { method?: string };
      if (opts.method === "node.pair.list") {
        return {
          pending: [
            {
              requestId: "request\u001b[2K-1",
              nodeId: "pending-node",
              displayName: "Pending\u001b[1A\nNode",
              remoteIp: "10.0.0.4\rrewritten",
              ts: now - 1_000,
            },
          ],
          paired: [
            {
              nodeId: "paired-node",
              displayName: "Paired\u001b[2K\nNode",
              remoteIp: "10.0.0.5\rrewritten",
            },
          ],
        };
      }
      if (opts.method === "node.list") {
        throw new Error("older gateway");
      }
      return { ok: true };
    });

    await runProgram(["nodes", "list"]);

    const output = getRuntimeOutput();
    expect(output).not.toContain("\u001b");
    expect(output).not.toContain("[2K");
    expect(output).toContain("Pending\\nNode");
    expect(output).toContain("Paired\\nNode");
    expect(output).toContain("10.0.0.5\\rrewritten");

    runtime.log.mockClear();
    await runProgram(["nodes", "list", "--json"]);

    const json = runtime.writeJson.mock.calls.at(-1)?.[0] as {
      pending?: Array<Record<string, unknown>>;
      paired?: Array<Record<string, unknown>>;
    };
    expect(json.pending?.[0]?.requestId).toBe("request\u001b[2K-1");
    expect(json.pending?.[0]?.displayName).toBe("Pending\u001b[1A\nNode");
    expect(json.paired?.[0]?.nodeId).toBe("paired-node");
    expect(json.paired?.[0]?.displayName).toBe("Paired\u001b[2K\nNode");
    expect(json.paired?.[0]?.remoteIp).toBe("10.0.0.5\rrewritten");
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

    expectGatewayRequest("node.list", {});
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

    expectGatewayRequest("node.pair.list", {});
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

    expectGatewayRequest("node.list", {});

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

    expectGatewayRequest("node.list", {});
    expectGatewayRequest("node.describe", { nodeId: "ios-node" });

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
    expectGatewayRequest("node.pair.approve", { requestId: "r1" });
  });

  it("runs nodes remove and calls node.pair.remove", async () => {
    callGateway.mockImplementation(async (...args: unknown[]) => {
      const opts = (args[0] ?? {}) as { method?: string };
      if (opts.method === "node.list") {
        return {
          nodes: [{ nodeId: "ios-node", displayName: "iOS Node", paired: true }],
        };
      }
      if (opts.method === "node.pair.list") {
        return {
          pending: [],
          paired: [{ nodeId: "ios-node", displayName: "iOS Node" }],
        };
      }
      if (opts.method === "node.pair.remove") {
        return { nodeId: "ios-node" };
      }
      return { ok: true };
    });

    await runProgram(["nodes", "remove", "--node", "iOS Node"]);
    expectGatewayRequest("node.pair.remove", { nodeId: "ios-node" });
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

    expectGatewayRequest("node.list", {});
    expectGatewayRequest("node.invoke", {
      nodeId: "ios-node",
      command: "canvas.eval",
      params: { javaScript: "1+1" },
      timeoutMs: 15000,
      idempotencyKey: "idem-test",
    });
  });
});
