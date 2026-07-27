// Program nodes basic e2e tests cover node command registration through the full CLI program.
import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createIosNodeListResponse } from "./program.nodes-test-helpers.js";
import { callGateway, runtime } from "./program.test-mocks.js";

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
    expect(
      gatewayRequests().find((request) => request.method === "node.list")?.useStoredDeviceAuth,
    ).toBe(true);
  });

  it("keeps connection age adjacent to connection status before pending approval", async () => {
    callGateway.mockResolvedValue({
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
    callGateway.mockResolvedValue({
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

  it("falls back to read-only node status when pairing diagnostics are unavailable", async () => {
    callGateway.mockImplementation(async (...args: unknown[]) => {
      const opts = (args[0] ?? {}) as {
        method?: string;
        scopes?: string[];
        useStoredDeviceAuth?: boolean;
      };
      if (opts.method === "node.list" && opts.useStoredDeviceAuth) {
        throw Object.assign(new Error("stored device auth unavailable"), {
          name: "GatewayCredentialsRequiredError",
        });
      }
      if (opts.method === "node.list" && opts.scopes?.includes("operator.pairing")) {
        throw Object.assign(new Error("unauthorized: pairing scope unavailable"), {
          name: "GatewayClientRequestError",
          gatewayCode: "INVALID_REQUEST",
          details: { code: "AUTH_SCOPE_MISMATCH" },
        });
      }
      if (opts.method === "node.list") {
        return {
          ts: Date.now(),
          nodes: [
            {
              nodeId: "read-only-node",
              displayName: "Read Only Node",
              approvalState: "approved",
              paired: true,
              connected: false,
            },
          ],
        };
      }
      return { ok: true };
    });

    await runProgram(["nodes", "status"]);

    const requests = gatewayRequests().filter((request) => request.method === "node.list");
    expect(requests).toHaveLength(3);
    expect(requests[0]?.useStoredDeviceAuth).toBe(true);
    expect(requests[0]?.requiredStoredDeviceAuthScopes).toEqual([
      "operator.read",
      "operator.pairing",
    ]);
    expect(requests[1]?.scopes).toEqual(["operator.read", "operator.pairing"]);
    expect(requests[1]?.clientName).toBe("gateway-client");
    expect(requests[1]?.mode).toBe("backend");
    expect(requests[1]?.requireLocalBackendSharedAuth).toBe(true);
    expect(requests[2]?.useStoredDeviceAuth).toBeUndefined();
    expect(requests[2]?.scopes).toBeUndefined();
    expect(getRuntimeOutput()).toContain("Read Only Node");
  });

  it("keeps remote explicit diagnostic credentials on the read-only path", async () => {
    callGateway.mockImplementation(async (...args: unknown[]) => {
      const opts = (args[0] ?? {}) as {
        method?: string;
        requireLocalBackendSharedAuth?: boolean;
        useStoredDeviceAuth?: boolean;
      };
      if (opts.method === "node.list" && opts.useStoredDeviceAuth) {
        throw Object.assign(new Error("stored device auth disabled for explicit credentials"), {
          name: "GatewayStoredDeviceAuthUnavailableError",
        });
      }
      if (opts.method === "node.list" && opts.requireLocalBackendSharedAuth) {
        throw Object.assign(new Error("local backend shared auth unavailable for remote target"), {
          name: "GatewayLocalBackendSharedAuthUnavailableError",
        });
      }
      return {
        nodes: [
          {
            nodeId: "remote-read-only-node",
            displayName: "Remote Read Only Node",
            paired: true,
            connected: false,
          },
        ],
      };
    });

    await runProgram([
      "nodes",
      "status",
      "--url",
      "wss://gateway.example.test",
      "--token",
      "explicit-token",
    ]);

    const requests = gatewayRequests().filter((request) => request.method === "node.list");
    expect(requests).toHaveLength(3);
    expect(requests[0]?.useStoredDeviceAuth).toBe(true);
    expect(requests[0]?.requiredStoredDeviceAuthScopes).toEqual([
      "operator.read",
      "operator.pairing",
    ]);
    expect(requests[1]?.scopes).toEqual(["operator.read", "operator.pairing"]);
    expect(requests[1]?.clientName).toBe("gateway-client");
    expect(requests[1]?.mode).toBe("backend");
    expect(requests[1]?.requireLocalBackendSharedAuth).toBe(true);
    expect(requests[2]?.scopes).toBeUndefined();
    expect(getRuntimeOutput()).toContain("Remote Read Only Node");
  });

  it("does not retry node diagnostics after a transport failure", async () => {
    callGateway.mockRejectedValue(new Error("gateway timed out"));

    await expect(runProgram(["nodes", "status"])).rejects.toThrow("exit");

    const requests = gatewayRequests().filter((request) => request.method === "node.list");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.useStoredDeviceAuth).toBe(true);
  });

  it("falls back to configured auth after stored device auth is rejected", async () => {
    callGateway.mockImplementation(async (...args: unknown[]) => {
      const opts = (args[0] ?? {}) as { method?: string; useStoredDeviceAuth?: boolean };
      if (opts.method === "node.list" && opts.useStoredDeviceAuth) {
        throw Object.assign(new Error("unauthorized: device token mismatch"), {
          name: "GatewayClientRequestError",
          gatewayCode: "INVALID_REQUEST",
          details: { code: "AUTH_DEVICE_TOKEN_MISMATCH" },
        });
      }
      if (opts.method === "node.list") {
        return {
          nodes: [
            {
              nodeId: "configured-auth-node",
              displayName: "Configured Auth Node",
              paired: true,
              connected: false,
            },
          ],
        };
      }
      return { ok: true };
    });

    await runProgram(["nodes", "status"]);

    const requests = gatewayRequests().filter((request) => request.method === "node.list");
    expect(requests).toHaveLength(2);
    expect(requests[0]?.useStoredDeviceAuth).toBe(true);
    expect(requests[1]?.useStoredDeviceAuth).toBeUndefined();
    expect(getRuntimeOutput()).toContain("Configured Auth Node");
  });

  it("falls back to configured auth when stored device auth lacks read scope", async () => {
    callGateway.mockImplementation(async (...args: unknown[]) => {
      const opts = (args[0] ?? {}) as {
        method?: string;
        scopes?: string[];
        useStoredDeviceAuth?: boolean;
      };
      if (opts.method === "node.list" && opts.useStoredDeviceAuth) {
        throw Object.assign(new Error("permission denied"), {
          name: "GatewayClientRequestError",
          gatewayCode: "FORBIDDEN",
          details: {
            code: "MISSING_SCOPE",
            missingScope: "operator.read",
            requiredScopes: ["operator.read"],
          },
        });
      }
      if (opts.method === "node.list" && opts.scopes?.includes("operator.pairing")) {
        return {
          nodes: [
            {
              nodeId: "shared-auth-node",
              displayName: "Shared Auth Node",
              paired: true,
              connected: false,
            },
          ],
        };
      }
      return { nodes: [] };
    });

    await runProgram(["nodes", "status"]);

    const requests = gatewayRequests().filter((request) => request.method === "node.list");
    expect(requests).toHaveLength(2);
    expect(requests[1]?.scopes).toEqual(["operator.read", "operator.pairing"]);
    expect(requests[1]?.clientName).toBe("gateway-client");
    expect(requests[1]?.mode).toBe("backend");
    expect(requests[1]?.requireLocalBackendSharedAuth).toBe(true);
    expect(getRuntimeOutput()).toContain("Shared Auth Node");
  });

  it("describes pending-only nodes through the pairing diagnostics view", async () => {
    callGateway.mockImplementation(async (...args: unknown[]) => {
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
    callGateway.mockImplementation(async (...args: unknown[]) => {
      const opts = (args[0] ?? {}) as {
        method?: string;
        params?: { nodeId?: string };
      };
      if (opts.method === "node.list") {
        throw Object.assign(new Error("unknown method: node.list"), {
          name: "GatewayClientRequestError",
          gatewayCode: "INVALID_REQUEST",
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
    callGateway.mockImplementation(async (...args: unknown[]) => {
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
    callGateway.mockImplementation(async (...args: unknown[]) => {
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
    const { callNodePairApprovalGatewayCliRuntime } = await import("./nodes-cli/rpc.runtime.js");

    await expect(
      callNodePairApprovalGatewayCliRuntime(
        "node.invoke" as never,
        { json: true },
        {},
        { scopes: ["operator.admin"] },
      ),
    ).rejects.toThrow("unsupported node pair approval gateway method: node.invoke");
    expect(callGateway).not.toHaveBeenCalled();
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
    const invokeRequest = gatewayRequests().find((candidate) => candidate.method === "node.invoke");
    expect(invokeRequest?.clientName).toBe("cli");
    expect(invokeRequest?.mode).toBe("cli");
  });
});
