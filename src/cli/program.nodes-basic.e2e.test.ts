// Program nodes basic e2e tests cover node command registration through the full CLI program.
import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GatewayProtocolRequestTimeoutError } from "../../packages/gateway-client/src/protocol-request.js";
import { GatewayClientRequestError } from "../../packages/gateway-client/src/request-error.js";
import {
  createIosNodeListResponse,
  formatRuntimeLogCallArg,
} from "./program.nodes-test-helpers.js";
import { programGatewayCallMock, runtime } from "./program.test-mocks.js";

let registerNodesCli: typeof import("./nodes-cli.js").registerNodesCli;

type GatewayCallRequest = {
  clientName?: string;
  method?: string;
  mode?: string;
  params?: unknown;
  scopes?: unknown;
  useStoredDeviceAuth?: boolean;
  requiredStoredDeviceAuthScopes?: unknown;
  requireLocalBackendSharedAuth?: boolean;
};

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
    return programGatewayCallMock.mock.calls.map(([request]) => request as GatewayCallRequest);
  }

  function writeJsonArgAt(index: number): unknown {
    const call =
      runtime.writeJson.mock.calls[index < 0 ? runtime.writeJson.mock.calls.length + index : index];
    if (!call) {
      throw new Error(`expected writeJson call ${index}`);
    }
    return call[0];
  }

  function expectGatewayRequest(method: string, params?: unknown): void {
    const request = gatewayRequests().find((candidate) => candidate.method === method);
    expect(request?.method).toBe(method);
    if (arguments.length > 1) {
      expect(request?.params).toEqual(params);
    }
  }

  function mockGatewayWithIosNodeListAnd(method: "node.describe" | "node.invoke", result: unknown) {
    programGatewayCallMock.mockImplementation(async (...args: unknown[]) => {
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
    programGatewayCallMock.mockImplementation(async (...args: unknown[]) => {
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
    const json = writeJsonArgAt(0) as {
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
    expect(output).toMatch(/^\{/);
    expect(output).not.toContain("Pending: 1 · Paired: 3");
    expect(output).not.toContain("Effective Only Unknown");
    expect(output).not.toContain("unpaired-live");
  });

  it("runs unfiltered nodes list with pairing data when node.list is unavailable", async () => {
    programGatewayCallMock.mockImplementation(async (...args: unknown[]) => {
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
    // The degraded table must never look authoritative: the fallback is
    // announced on stderr so --json stdout stays parseable.
    expect(runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("live node view unavailable"),
    );
    expect(output).not.toContain("live node view unavailable");
  });

  it("sanitizes untrusted nodes list table fields while preserving JSON values", async () => {
    const now = Date.now();
    programGatewayCallMock.mockImplementation(async (...args: unknown[]) => {
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

    const json = writeJsonArgAt(-1) as {
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
    programGatewayCallMock.mockImplementation(async (...args: unknown[]) => {
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

  it("counts catalog-only paired nodes in the filtered list total", async () => {
    programGatewayCallMock.mockImplementation(async (...args: unknown[]) => {
      const opts = (args[0] ?? {}) as { method?: string };
      if (opts.method === "node.pair.list") {
        return {
          pending: [],
          paired: [{ nodeId: "paired-store", displayName: "Paired Store" }],
        };
      }
      if (opts.method === "node.list") {
        return {
          nodes: [
            { nodeId: "paired-store", connected: true },
            {
              nodeId: "catalog-only",
              displayName: "Catalog Only",
              paired: true,
              connected: true,
            },
          ],
        };
      }
      return { ok: true };
    });

    await runProgram(["nodes", "list", "--connected"]);

    const output = getRuntimeOutput();
    expect(output).toMatch(/^Pending: 0 · Paired: 2$/m);
    expect(output).toContain("Paired Store");
    expect(output).toContain("Catalog Only");
  });

  it("runs nodes status --last-connected using the recorded node.list fact", async () => {
    const now = Date.now();
    const methods: string[] = [];
    programGatewayCallMock.mockImplementation(async (...args: unknown[]) => {
      const opts = (args[0] ?? {}) as { method?: string };
      methods.push(opts.method ?? "");
      if (opts.method === "node.list") {
        return {
          ts: now,
          nodes: [
            { nodeId: "n1", displayName: "One", connected: false, lastConnectedAtMs: now - 1_000 },
            {
              nodeId: "n2",
              displayName: "Two",
              connected: false,
              lastConnectedAtMs: now - 2 * 24 * 60 * 60 * 1000,
            },
          ],
        };
      }
      return { ok: true };
    });
    await runProgram(["nodes", "status", "--last-connected", "24h"]);

    // The gateway records lastConnectedAtMs on node.list rows; re-joining
    // node.pair.list broke --last-connected for read-scoped callers.
    expect(methods).not.toContain("node.pair.list");
    const output = getRuntimeOutput();
    expect(output).toContain("One");
    expect(output).not.toContain("Two");
  });

  it.each([
    { command: "status", duration: "24h" },
    { command: "status", duration: "1h30m" },
    { command: "status", duration: "0" },
    { command: "status", duration: " 24H " },
    { command: "list", duration: "24h" },
    { command: "list", duration: "1h30m" },
    { command: "list", duration: "0" },
    { command: "list", duration: " 24H " },
  ])("preserves nodes $command --last-connected $duration", async ({ command, duration }) => {
    const node = {
      nodeId: "recent-node",
      displayName: "Recent Node",
      paired: true,
      connected: true,
      lastConnectedAtMs: Date.now() + 60_000,
    };
    programGatewayCallMock.mockImplementation(async (...args: unknown[]) => {
      const { method } = (args[0] ?? {}) as { method?: string };
      return method === "node.pair.list" ? { pending: [], paired: [node] } : { nodes: [node] };
    });

    await runProgram(["nodes", command, "--last-connected", duration, "--json"]);

    const result = writeJsonArgAt(0) as {
      nodes?: Array<{ nodeId: string }>;
      paired?: Array<{ nodeId: string }>;
    };
    expect((result.nodes ?? result.paired)?.map(({ nodeId }) => nodeId)).toEqual(["recent-node"]);
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
        "hw:",
        "samsung",
        "SM-X926B",
        "Status",
        "unpaired",
        "connected",
        "Caps",
        "camera",
        "canvas",
      ],
    },
    {
      label: "pending first node approval",
      node: {
        nodeId: "pending-node",
        displayName: "Pending Node",
        caps: [],
        commands: [],
        approvalState: "pending-approval",
        pendingRequestId: "request-approval",
        pendingDeclaredCaps: ["system"],
        pendingDeclaredCommands: ["system.run"],
        paired: true,
        connected: true,
      },
      expectedOutput: [
        "Pending Node",
        "approval pending",
        "Approval pending for Pending Node",
        "openclaw nodes approve request-approval",
      ],
    },
    {
      label: "pending node reapproval",
      node: {
        nodeId: "pending-reapproval-node",
        displayName: "Pending Reapproval Node",
        caps: ["camera"],
        commands: ["camera.snap"],
        approvalState: "pending-reapproval",
        pendingRequestId: "request-reapproval",
        pendingDeclaredCaps: ["camera", "system"],
        pendingDeclaredCommands: ["camera.snap", "system.run"],
        paired: true,
        connected: true,
      },
      expectedOutput: [
        "Pending Reapproval Node",
        "reapproval pending",
        "Reapproval pending for Pending Reapproval Node",
        "openclaw nodes approve request-reapproval",
      ],
    },
  ])("runs nodes status and renders $label", async ({ node, expectedOutput }) => {
    programGatewayCallMock.mockResolvedValue({
      ts: Date.now(),
      nodes: [node],
    });
    await runProgram(["nodes", "status"]);

    expectGatewayRequest("node.list", {});

    const output = getRuntimeOutput();
    for (const expected of expectedOutput) {
      expect(output).toContain(expected);
    }
    expect(
      gatewayRequests().find((request) => request.method === "node.list")?.useStoredDeviceAuth,
    ).toBe(true);
  });

  it.each([
    {
      platform: "win32",
      pathEnv: "C:\\one;D:\\two;E:\\three;F:\\four",
      expectedPath: "path: C:\\one;D:\\two;…;F:\\four",
      rejectedPath: "path: C:\\one;D:…:\\four",
    },
    {
      platform: "windows",
      pathEnv: "C:\\one;D:\\two;E:\\three;F:\\four",
      expectedPath: "path: C:\\one;D:\\two;…;F:\\four",
      rejectedPath: "path: C:\\one;D:…:\\four",
    },
    {
      platform: "linux",
      pathEnv: "/one:/two:/three:/four",
      expectedPath: "path: /one:/two:…:/four",
      rejectedPath: "path: /one:/two:/three:/four",
    },
  ])("renders $platform node PATH entries with their platform delimiter", async (fixture) => {
    programGatewayCallMock.mockResolvedValue({
      ts: Date.now(),
      nodes: [
        {
          nodeId: `${fixture.platform}-node`,
          displayName: `${fixture.platform} node`,
          platform: fixture.platform,
          pathEnv: fixture.pathEnv,
          paired: true,
          connected: true,
        },
      ],
    });

    await runProgram(["nodes", "status"]);

    const output = getRuntimeOutput();
    expect(output).toContain(fixture.expectedPath);
    expect(output).not.toContain(fixture.rejectedPath);
  });

  it("keeps connection age adjacent to connection status before pending approval", async () => {
    programGatewayCallMock.mockResolvedValue({
      ts: Date.now(),
      nodes: [
        {
          nodeId: "pending-reapproval-node",
          displayName: "Pending Reapproval Node",
          approvalState: "pending-reapproval",
          pendingRequestId: "request-reapproval",
          paired: true,
          connected: true,
          connectedAtMs: Date.now() - 60_000,
        },
      ],
    });

    await runProgram(["nodes", "status"]);

    expect(getRuntimeOutput()).toMatch(/connected \([^)]* ago\) · reapproval pending/);
  });

  it("runs nodes describe and calls node.describe", async () => {
    mockGatewayWithIosNodeListAnd("node.describe", {
      ts: Date.now(),
      nodeId: "ios-node",
      displayName: "iOS Node",
      caps: ["camera"],
      commands: ["camera.snap"],
      approvalState: "pending-reapproval",
      pendingRequestId: "request-approval",
      pendingDeclaredCaps: ["camera", "canvas"],
      pendingDeclaredCommands: ["camera.snap", "canvas.eval\u001b[2K", "canvas.snapshot"],
      pendingDeclaredPermissions: { camera: true },
      connected: true,
    });

    await runProgram(["nodes", "describe", "--node", "ios-node"]);

    expectGatewayRequest("node.list", {});
    expectGatewayRequest("node.describe", { nodeId: "ios-node" });
    const describeRequest = gatewayRequests().find(
      (candidate) => candidate.method === "node.describe",
    );
    expect(describeRequest?.clientName).toBe("cli");
    expect(describeRequest?.mode).toBe("cli");
    expect(describeRequest?.useStoredDeviceAuth).toBe(true);

    const out = getRuntimeOutput();
    expect(out).toContain("Commands");
    expect(out).toContain("camera.snap");
    expect(out).toContain("Approval");
    expect(out).toContain("reapproval pending");
    expect(out).toContain("Pending request");
    expect(out).toContain("request-approval");
    expect(out).toContain("Pending caps");
    expect(out).toContain("canvas");
    expect(out).toContain("Pending commands");
    expect(out).toContain("canvas.eval");
    expect(out).toContain("openclaw nodes approve request-approval");
    expect(out).not.toContain("\u001b");
    expect(out).not.toContain("[2K");
  });

  it("keeps explicit gateway options in node reapproval guidance without leaking auth", async () => {
    programGatewayCallMock.mockResolvedValue({
      ts: Date.now(),
      nodes: [
        {
          nodeId: "pending-node",
          displayName: "Pending Node",
          approvalState: "pending-reapproval",
          pendingRequestId: "request-reapproval",
          paired: true,
          connected: true,
        },
      ],
    });

    await runProgram([
      "nodes",
      "status",
      "--url",
      "ws://gateway-user:url-secret@gateway.example:18789/openclaw?cluster=qa",
      "--timeout",
      "3000",
      "--token",
      "secret-token",
    ]);

    const output = getRuntimeOutput();
    expect(output).toContain("openclaw nodes approve request-reapproval --timeout 3000");
    expect(output).toContain("Reuse the same connection options when rerunning: --url, --token.");
    expect(output).not.toContain("gateway-user");
    expect(output).not.toContain("url-secret");
    expect(output).not.toContain("gateway.example");
    expect(output).not.toContain("secret-token");
  });

  it("describes pending-only nodes through the pairing diagnostics view", async () => {
    programGatewayCallMock.mockImplementation(async (...args: unknown[]) => {
      const opts = (args[0] ?? {}) as {
        method?: string;
        params?: { nodeId?: string };
        useStoredDeviceAuth?: boolean;
      };
      if (opts.method === "node.list") {
        return opts.useStoredDeviceAuth
          ? {
              nodes: [
                {
                  nodeId: "pending-only-node",
                  displayName: "Pending Only Node",
                  approvalState: "pending-approval",
                  pendingRequestId: "pending-only-request",
                  paired: false,
                  connected: false,
                },
              ],
            }
          : { nodes: [] };
      }
      if (opts.method === "node.describe" && opts.params?.nodeId === "pending-only-node") {
        return {
          nodeId: "pending-only-node",
          displayName: "Pending Only Node",
          approvalState: "pending-approval",
          pendingRequestId: "pending-only-request",
          paired: false,
          connected: false,
        };
      }
      return { ok: true };
    });

    await runProgram(["nodes", "describe", "--node", "pending-only-node"]);

    const describeRequest = gatewayRequests().find((request) => request.method === "node.describe");
    expect(describeRequest?.params).toEqual({ nodeId: "pending-only-node" });
    expect(describeRequest?.useStoredDeviceAuth).toBe(true);
    expect(getRuntimeOutput()).toContain("pending-only-request");
  });

  it("describes nodes through the paired-node fallback on older gateways", async () => {
    programGatewayCallMock.mockImplementation(async (...args: unknown[]) => {
      const opts = (args[0] ?? {}) as {
        method?: string;
        params?: { nodeId?: string };
      };
      if (opts.method === "node.list") {
        throw new GatewayClientRequestError({
          code: "INVALID_REQUEST",
          message: "unknown method: node.list",
        });
      }
      if (opts.method === "node.pair.list") {
        return {
          pending: [],
          paired: [{ nodeId: "legacy-node", displayName: "Legacy Node" }],
        };
      }
      if (opts.method === "node.describe" && opts.params?.nodeId === "legacy-node") {
        return {
          nodeId: "legacy-node",
          displayName: "Legacy Node",
          paired: true,
          connected: false,
        };
      }
      return { ok: true };
    });

    await runProgram(["nodes", "describe", "--node", "legacy-node"]);

    expectGatewayRequest("node.pair.list", {});
    expectGatewayRequest("node.describe", { nodeId: "legacy-node" });
    expect(getRuntimeOutput()).toContain("Legacy Node");
  });

  it("does not recommend approval from a stale pending request id alone", async () => {
    mockGatewayWithIosNodeListAnd("node.describe", {
      nodeId: "ios-node",
      displayName: "iOS Node",
      approvalState: "approved",
      pendingRequestId: "stale-request",
      connected: true,
    });

    await runProgram(["nodes", "describe", "--node", "ios-node", "--token", "secret-token"]);

    const output = getRuntimeOutput();
    expect(output).toContain("stale-request");
    expect(output).not.toContain("openclaw nodes approve stale-request");
    expect(output).not.toContain("Reuse the same --token option when rerunning.");
    expect(output).not.toContain("secret-token");
  });

  it("runs nodes approve with the pending request approval scopes", async () => {
    programGatewayCallMock.mockImplementation(async (...args: unknown[]) => {
      const opts = (args[0] ?? {}) as { method?: string };
      if (opts.method === "node.pair.list") {
        return {
          pending: [
            {
              requestId: "r1",
              nodeId: "n1",
              ts: Date.now(),
              requiredApproveScopes: ["operator.pairing", "operator.admin"],
            },
          ],
          paired: [],
        };
      }
      if (opts.method === "node.pair.approve") {
        return {
          requestId: "r1",
          node: { nodeId: "n1", token: "t1" },
        };
      }
      return { ok: true };
    });

    await runProgram(["nodes", "approve", "r1"]);
    expectGatewayRequest("node.pair.list", {});
    expectGatewayRequest("node.pair.approve", { requestId: "r1" });
    const listRequest = gatewayRequests().find(
      (candidate) => candidate.method === "node.pair.list",
    );
    const approveRequest = gatewayRequests().find(
      (candidate) => candidate.method === "node.pair.approve",
    );
    expect(listRequest?.clientName).toBe("gateway-client");
    expect(listRequest?.mode).toBe("backend");
    expect(approveRequest?.scopes).toEqual(["operator.pairing", "operator.admin"]);
    expect(approveRequest?.clientName).toBe("gateway-client");
    expect(approveRequest?.mode).toBe("backend");
  });

  it("falls back to command-derived nodes approve scopes", async () => {
    programGatewayCallMock.mockImplementation(async (...args: unknown[]) => {
      const opts = (args[0] ?? {}) as { method?: string };
      if (opts.method === "node.pair.list") {
        return {
          pending: [
            {
              requestId: "r1",
              nodeId: "n1",
              ts: Date.now(),
              commands: ["system.run"],
            },
          ],
          paired: [],
        };
      }
      if (opts.method === "node.pair.approve") {
        return {
          requestId: "r1",
          node: { nodeId: "n1", token: "t1" },
        };
      }
      return { ok: true };
    });

    await runProgram(["nodes", "approve", "r1"]);

    const approveRequest = gatewayRequests().find(
      (candidate) => candidate.method === "node.pair.approve",
    );
    expect(approveRequest?.scopes).toEqual(["operator.pairing", "operator.admin"]);
  });

  it("rejects unsupported node approval backend methods at runtime", async () => {
    const { callNodePairApprovalGatewayCli } = await import("./nodes-cli/rpc.js");

    await expect(
      callNodePairApprovalGatewayCli(
        "node.invoke" as never,
        { json: true },
        {},
        { scopes: ["operator.admin"] },
      ),
    ).rejects.toThrow("unsupported node pair approval gateway method: node.invoke");
    expect(programGatewayCallMock).not.toHaveBeenCalled();
  });

  it("runs nodes remove and calls node.pair.remove", async () => {
    programGatewayCallMock.mockImplementation(async (...args: unknown[]) => {
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

  it("runs nodes rename and preserves the successful node.rename payload", async () => {
    programGatewayCallMock.mockImplementation(async (...args: unknown[]) => {
      const { method } = (args[0] ?? {}) as { method?: string };
      return method === "node.list"
        ? { nodes: [{ nodeId: "ios-node", displayName: "iOS Node", paired: true }] }
        : { ok: true, nodeId: "ios-node", displayName: "Renamed Node" };
    });

    await runProgram([
      "nodes",
      "rename",
      "--node",
      "iOS Node",
      "--name",
      " Renamed Node ",
      "--json",
    ]);

    expectGatewayRequest("node.rename", { nodeId: "ios-node", displayName: "Renamed Node" });
    expect(writeJsonArgAt(0)).toEqual({
      ok: true,
      nodeId: "ios-node",
      displayName: "Renamed Node",
    });
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
    const invokeRequest = gatewayRequests().find((candidate) => candidate.method === "node.invoke");
    expect(invokeRequest?.clientName).toBe("cli");
    expect(invokeRequest?.mode).toBe("cli");
  });

  it("reports the inventory timeout instead of invoking a stale paired node", async () => {
    const timeout = new GatewayProtocolRequestTimeoutError({
      method: "node.list",
      timeoutMs: 80,
      requestSent: true,
    });
    programGatewayCallMock.mockImplementation(async (...args: unknown[]) => {
      const { method } = (args[0] ?? {}) as { method?: string };
      if (method === "node.list") {
        throw timeout;
      }
      if (method === "node.pair.list") {
        return { pending: [], paired: [{ nodeId: "stale-node", displayName: "Stale Node" }] };
      }
      throw new GatewayClientRequestError({
        code: "UNAVAILABLE",
        message: "node not connected",
      });
    });

    await expect(
      runProgram(["nodes", "invoke", "--node", "Stale Node", "--command", "canvas.hide"]),
    ).rejects.toThrow("exit");

    expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining(timeout.message));
    expect(gatewayRequests().map(({ method }) => method)).toEqual(["node.list"]);
    expect(runtime.writeJson).not.toHaveBeenCalled();
  });
});
