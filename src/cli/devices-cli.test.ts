// Devices CLI tests cover device command registration and output behavior.
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stripAnsi } from "../../packages/terminal-core/src/ansi.js";
import { registerDevicesCli } from "./devices-cli.js";

const mocks = vi.hoisted(() => ({
  runtime: {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
    writeJson: vi.fn(),
  },
  callGateway: vi.fn(),
  formatGatewayTransportErrorJson: vi.fn(),
  buildGatewayConnectionDetails: vi.fn(() => ({
    url: "ws://127.0.0.1:18789",
    urlSource: "local loopback",
    message: "",
  })),
  listDevicePairing: vi.fn(),
  approveDevicePairing: vi.fn(),
  summarizeDeviceTokens: vi.fn(),
  withProgress: vi.fn(async (_opts: unknown, fn: () => Promise<unknown>) => await fn()),
}));

const {
  runtime,
  callGateway,
  formatGatewayTransportErrorJson,
  buildGatewayConnectionDetails,
  listDevicePairing,
  approveDevicePairing,
  summarizeDeviceTokens,
} = mocks;

vi.mock("../gateway/call.js", () => ({
  callGateway: mocks.callGateway,
  formatGatewayTransportErrorJson: mocks.formatGatewayTransportErrorJson,
  buildGatewayConnectionDetails: mocks.buildGatewayConnectionDetails,
}));

vi.mock("./progress.js", () => ({
  withProgress: mocks.withProgress,
}));

vi.mock("../infra/device-pairing.js", () => ({
  listDevicePairing: mocks.listDevicePairing,
  approveDevicePairing: mocks.approveDevicePairing,
  summarizeDeviceTokens: mocks.summarizeDeviceTokens,
}));

vi.mock("../runtime.js", () => ({
  defaultRuntime: mocks.runtime,
  writeRuntimeJson: (
    targetRuntime: { log: (...args: unknown[]) => void },
    value: unknown,
    space = 2,
  ) => targetRuntime.log(JSON.stringify(value, null, space > 0 ? space : undefined)),
}));

async function runDevicesApprove(argv: string[]) {
  await runDevicesCommand(["approve", ...argv]);
}

async function runDevicesCommand(argv: string[]) {
  const program = new Command();
  registerDevicesCli(program);
  await program.parseAsync(["devices", ...argv], { from: "user" });
}

function readRuntimeCallText(call: unknown[] | undefined): string {
  const value = call?.[0];
  return typeof value === "string" ? value : "";
}

function readRuntimeOutput(): string {
  return runtime.log.mock.calls.map((entry) => readRuntimeCallText(entry)).join("\n");
}

function readRuntimeErrorOutput(): string {
  return runtime.error.mock.calls.map((entry) => readRuntimeCallText(entry)).join("\n");
}

function pendingDevice(overrides: Record<string, unknown> = {}) {
  return {
    requestId: "req-1",
    deviceId: "device-1",
    displayName: "Device One",
    role: "operator",
    scopes: ["operator.admin"],
    ts: 1,
    ...overrides,
  };
}

function pairedDevice(overrides: Record<string, unknown> = {}) {
  return {
    deviceId: "device-1",
    displayName: "Device One",
    roles: ["operator"],
    scopes: ["operator.read"],
    ...overrides,
  };
}

function mockGatewayPairingList(
  pendingOverrides: Record<string, unknown> = {},
  pairedOverrides: Record<string, unknown> = {},
) {
  callGateway.mockResolvedValueOnce({
    pending: [pendingDevice(pendingOverrides)],
    paired: [pairedDevice(pairedOverrides)],
  });
}

function rejectGatewayForLocalFallback(message = "gateway closed (1008): pairing required") {
  callGateway.mockRejectedValueOnce(new Error(message));
}

function mockLocalPairingFallback(message?: string) {
  rejectGatewayForLocalFallback(message);
  listDevicePairing.mockResolvedValueOnce({
    pending: [{ requestId: "req-1", deviceId: "device-1", publicKey: "pk", ts: 1 }],
    paired: [],
  });
  summarizeDeviceTokens.mockReturnValue(undefined);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    throw new Error(`${label} was not an object`);
  }
  return value as Record<string, unknown>;
}

function expectRecordFields(record: Record<string, unknown>, fields: Record<string, unknown>) {
  for (const [key, value] of Object.entries(fields)) {
    expect(record[key]).toEqual(value);
  }
}

function requireGatewayCall(index: number): Record<string, unknown> {
  const call = (callGateway.mock.calls as unknown[][])[index]?.[0];
  return requireRecord(call, `gateway call ${index + 1}`);
}

function expectGatewayCall(index: number, fields: Record<string, unknown>) {
  expectRecordFields(requireGatewayCall(index), fields);
}

function hasGatewayMethod(method: string): boolean {
  return (callGateway.mock.calls as unknown[][]).some((call) => {
    const params = call[0];
    return (
      typeof params === "object" &&
      params !== null &&
      "method" in params &&
      params.method === method
    );
  });
}

describe("devices cli approve", () => {
  it("uses admin scope when approving an admin-scope request", async () => {
    callGateway
      .mockResolvedValueOnce({
        pending: [pendingDevice({ requestId: "req-123", scopes: ["operator.admin"] })],
        paired: [],
      })
      .mockResolvedValueOnce({ device: { deviceId: "device-1" } });

    await runDevicesApprove(["req-123"]);

    expect(callGateway).toHaveBeenCalledTimes(2);
    expectGatewayCall(0, { method: "device.pair.list" });
    expectGatewayCall(1, {
      method: "device.pair.approve",
      params: { requestId: "req-123" },
      scopes: ["operator.admin"],
    });
  });

  it("keeps pairing scope for non-admin device approvals", async () => {
    callGateway
      .mockResolvedValueOnce({
        pending: [
          pendingDevice({
            requestId: "req-pairing",
            scopes: ["operator.pairing"],
          }),
        ],
        paired: [],
      })
      .mockResolvedValueOnce({ device: { deviceId: "device-1" } });

    await runDevicesApprove(["req-pairing"]);

    expectGatewayCall(1, {
      method: "device.pair.approve",
      params: { requestId: "req-pairing" },
      scopes: ["operator.pairing"],
    });
  });

  it("retries explicit approval with admin scope when a paired-device session is ownership-denied", async () => {
    callGateway
      .mockResolvedValueOnce({
        pending: [],
        paired: [],
      })
      .mockRejectedValueOnce(new Error("GatewayClientRequestError: device pairing approval denied"))
      .mockResolvedValueOnce({ device: { deviceId: "device-2" } });

    await runDevicesApprove(["req-cross-device"]);

    expect(callGateway).toHaveBeenCalledTimes(3);
    expectGatewayCall(1, {
      method: "device.pair.approve",
      params: { requestId: "req-cross-device" },
      scopes: undefined,
    });
    expectGatewayCall(2, {
      method: "device.pair.approve",
      params: { requestId: "req-cross-device" },
      scopes: ["operator.admin"],
    });
  });

  it("uses admin scope when a repair approval would inherit an admin token", async () => {
    callGateway
      .mockResolvedValueOnce({
        pending: [
          pendingDevice({
            requestId: "req-repair",
            scopes: [],
          }),
        ],
        paired: [
          pairedDevice({
            tokens: [{ role: "operator", scopes: ["operator.admin"] }],
          }),
        ],
      })
      .mockResolvedValueOnce({ device: { deviceId: "device-1" } });

    await runDevicesApprove(["req-repair"]);

    expectGatewayCall(1, {
      method: "device.pair.approve",
      params: { requestId: "req-repair" },
      scopes: ["operator.admin"],
    });
  });

  it("inherits non-admin operator token scopes when a repair approval omits explicit scopes", async () => {
    callGateway
      .mockResolvedValueOnce({
        pending: [
          pendingDevice({
            requestId: "req-read-repair",
            scopes: [],
          }),
        ],
        paired: [
          pairedDevice({
            tokens: [{ role: "operator", scopes: ["operator.read"] }],
          }),
        ],
      })
      .mockResolvedValueOnce({ device: { deviceId: "device-1" } });

    await runDevicesApprove(["req-read-repair"]);

    expectGatewayCall(1, {
      method: "device.pair.approve",
      params: { requestId: "req-read-repair" },
      scopes: ["operator.pairing", "operator.read"],
    });
  });

  it("falls back to paired scopes when a repair approval omits explicit scopes and no operator token is stored", async () => {
    callGateway
      .mockResolvedValueOnce({
        pending: [
          pendingDevice({
            requestId: "req-read-repair-scopes",
            scopes: [],
          }),
        ],
        paired: [
          pairedDevice({
            scopes: ["operator.read"],
          }),
        ],
      })
      .mockResolvedValueOnce({ device: { deviceId: "device-1" } });

    await runDevicesApprove(["req-read-repair-scopes"]);

    expectGatewayCall(1, {
      method: "device.pair.approve",
      params: { requestId: "req-read-repair-scopes" },
      scopes: ["operator.pairing", "operator.read"],
    });
  });

  it("prints selected details and exits when implicit approval is used", async () => {
    callGateway.mockResolvedValueOnce({
      pending: [
        {
          requestId: "req-abc",
          deviceId: "device-9",
          displayName: "Device Nine",
          role: "operator",
          scopes: ["operator.admin"],
          remoteIp: "10.0.0.9",
          ts: 1000,
        },
      ],
      paired: [
        {
          deviceId: "device-9",
          displayName: "Device Nine",
          roles: ["operator"],
          scopes: ["operator.read"],
        },
      ],
    });

    await runDevicesApprove([]);

    expect(callGateway).toHaveBeenCalledTimes(1);
    expectGatewayCall(0, { method: "device.pair.list" });
    const logOutput = runtime.log.mock.calls.map((c) => readRuntimeCallText(c)).join("\n");
    expect(logOutput).toContain("req-abc");
    expect(logOutput).toContain("Device Nine");
    expect(logOutput).toContain("Approved: roles: operator; scopes: operator.read");
    expect(logOutput).toContain("Requested scopes exceed the current approval");
    expect(readRuntimeErrorOutput()).toContain("openclaw devices approve req-abc");
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(hasGatewayMethod("device.pair.approve")).toBe(false);
  });

  it("sanitizes preview ip output for implicit approval", async () => {
    callGateway.mockResolvedValueOnce({
      pending: [
        {
          requestId: "req-abc",
          deviceId: "device-9",
          displayName: "Device Nine",
          role: "operator",
          scopes: ["operator.admin"],
          remoteIp: "10.0.0.9\rspoof",
          ts: 1000,
        },
      ],
      paired: [
        {
          deviceId: "device-9",
          displayName: "Device Nine",
          roles: ["operator"],
          scopes: ["operator.read"],
        },
      ],
    });

    await runDevicesApprove([]);

    const logOutput = runtime.log.mock.calls.map((c) => readRuntimeCallText(c)).join("\n");
    expect(logOutput).not.toContain("\r");
    expect(logOutput).toContain("IP:     10.0.0.9spoof");
  });

  it.each([
    {
      name: "id is omitted",
      args: [] as string[],
      pending: [
        { requestId: "req-1", ts: 1000 },
        { requestId: "req-2", ts: 2000 },
      ],
      expectedRequestId: "req-2",
    },
    {
      name: "--latest is passed",
      args: ["req-old", "--latest"] as string[],
      pending: [
        { requestId: "req-2", ts: 2000 },
        { requestId: "req-3", ts: 3000 },
      ],
      expectedRequestId: "req-3",
    },
  ])("previews latest pending request when $name", async ({ args, pending, expectedRequestId }) => {
    callGateway.mockResolvedValueOnce({
      pending,
    });

    await runDevicesApprove(args);

    expectGatewayCall(0, { method: "device.pair.list" });
    expect(hasGatewayMethod("device.pair.approve")).toBe(false);
    expect(readRuntimeErrorOutput()).toContain(`openclaw devices approve ${expectedRequestId}`);
  });

  it("falls back to device id when selected pending display name is blank", async () => {
    callGateway.mockResolvedValueOnce({
      pending: [
        {
          requestId: "req-blank",
          deviceId: "device-9",
          displayName: "   ",
          ts: 1000,
        },
      ],
    });

    await runDevicesApprove([]);

    const logOutput = runtime.log.mock.calls.map((c) => readRuntimeCallText(c)).join("\n");
    expect(logOutput).toContain("device-9");
    expect(readRuntimeErrorOutput()).toContain("openclaw devices approve req-blank");
    expect(hasGatewayMethod("device.pair.approve")).toBe(false);
  });

  it("includes explicit gateway flags in the rerun approval command", async () => {
    callGateway.mockResolvedValueOnce({
      pending: [{ requestId: "req-url", deviceId: "device-9", ts: 1000 }],
    });

    await runDevicesApprove([
      "--latest",
      "--url",
      "ws://gateway.example:18789/openclaw?cluster=qa lab",
      "--timeout",
      "3000",
      "--token",
      "secret-token",
    ]);

    const errorOutput = runtime.error.mock.calls.map((c) => readRuntimeCallText(c)).join("\n");
    expect(errorOutput).toContain(
      "openclaw devices approve req-url --url 'ws://gateway.example:18789/openclaw?cluster=qa lab' --timeout 3000",
    );
    expect(errorOutput).toContain("Reuse the same --token option when rerunning.");
    expect(errorOutput).not.toContain("secret-token");
    expect(hasGatewayMethod("device.pair.approve")).toBe(false);
  });

  it("returns JSON for implicit approval preview in JSON mode", async () => {
    callGateway.mockResolvedValueOnce({
      pending: [{ requestId: "req-json", deviceId: "device-json", ts: 1000 }],
      paired: [],
    });

    await runDevicesApprove(["--latest", "--json", "--url", "ws://gateway.example:18789"]);

    expect(runtime.log).not.toHaveBeenCalled();
    expect(runtime.error).not.toHaveBeenCalled();
    expect(runtime.writeJson).toHaveBeenCalledWith({
      selected: { requestId: "req-json", deviceId: "device-json", ts: 1000 },
      approvalState: {
        kind: "new-pairing",
        requested: { roles: [], scopes: [] },
        approved: null,
      },
      approveCommand: "openclaw devices approve req-json --url ws://gateway.example:18789 --json",
      requiresAuthFlags: {
        token: false,
        password: false,
      },
    });
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(hasGatewayMethod("device.pair.approve")).toBe(false);
  });

  it("prints an error and exits when no pending requests are available", async () => {
    callGateway.mockResolvedValueOnce({ pending: [] });

    await runDevicesApprove([]);

    expect(callGateway).toHaveBeenCalledTimes(1);
    expectGatewayCall(0, { method: "device.pair.list" });
    expect(runtime.error).toHaveBeenCalledWith("No pending device pairing requests to approve");
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(hasGatewayMethod("device.pair.approve")).toBe(false);
  });

  it("suggests pending node approval when a device IP is approved at the wrong layer", async () => {
    callGateway
      .mockResolvedValueOnce({
        pending: [],
        paired: [
          pairedDevice({
            deviceId: "android-node",
            displayName: "Colin's S25",
            remoteIp: "192.168.0.202",
            roles: ["node"],
          }),
        ],
      })
      .mockRejectedValueOnce(new Error("device pairing approval denied"))
      .mockRejectedValueOnce({ message: "unknown requestId", gatewayCode: "INVALID_REQUEST" })
      .mockResolvedValueOnce({
        nodes: [
          {
            nodeId: "android-node",
            displayName: "Colin's S25",
            approvalState: "pending-reapproval",
            pendingRequestId: "node-req-1",
          },
        ],
      })
      .mockResolvedValueOnce({
        pending: [],
        paired: [
          pairedDevice({
            deviceId: "android-node",
            displayName: "Colin's S25",
            remoteIp: "192.168.0.202",
            roles: ["node"],
          }),
        ],
      });

    await runDevicesApprove([
      "192.168.0.202",
      "--url",
      "ws://gateway-user:url-secret@gateway.example:18789/openclaw?cluster=qa",
      "--token",
      "secret-token",
    ]);

    expectGatewayCall(3, { method: "node.list" });
    expectGatewayCall(4, { method: "device.pair.list" });
    const errorOutput = readRuntimeErrorOutput();
    expect(errorOutput).toContain("No pending device request matches");
    expect(errorOutput).toContain("Node reapproval pending for Colin's S25");
    expect(errorOutput).toContain("openclaw nodes approve node-req-1");
    expect(errorOutput).toContain(
      "Reuse the same connection options when rerunning: --url, --token.",
    );
    expect(errorOutput).not.toContain("gateway-user");
    expect(errorOutput).not.toContain("url-secret");
    expect(errorOutput).not.toContain("gateway.example");
    expect(errorOutput).not.toContain("secret-token");
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it("does not suggest node approval for a wrong-layer device IP when only display names match", async () => {
    callGateway
      .mockResolvedValueOnce({
        pending: [],
        paired: [
          pairedDevice({
            deviceId: "android-node",
            displayName: "Shared Phone",
            remoteIp: "192.168.0.202",
            roles: ["node"],
          }),
        ],
      })
      .mockRejectedValueOnce(new Error("device pairing approval denied"))
      .mockRejectedValueOnce({ message: "unknown requestId", gatewayCode: "INVALID_REQUEST" })
      .mockResolvedValueOnce({
        nodes: [
          {
            nodeId: "unrelated-node",
            displayName: "Shared Phone",
            remoteIp: "10.0.0.50",
            approvalState: "pending-reapproval",
            pendingRequestId: "node-req-unrelated",
          },
        ],
      })
      .mockResolvedValueOnce({
        pending: [],
        paired: [
          pairedDevice({
            deviceId: "android-node",
            displayName: "Shared Phone",
            remoteIp: "192.168.0.202",
            roles: ["node"],
          }),
        ],
      });

    await runDevicesApprove(["192.168.0.202"]);

    expectGatewayCall(3, { method: "node.list" });
    expectGatewayCall(4, { method: "device.pair.list" });
    const errorOutput = readRuntimeErrorOutput();
    expect(errorOutput).toContain("No pending device request matches");
    expect(errorOutput).not.toContain("node-req-unrelated");
    expect(errorOutput).not.toContain("openclaw nodes approve");
  });

  it("does not suggest node approval when the query only matches a paired device display name", async () => {
    callGateway
      .mockResolvedValueOnce({
        pending: [],
        paired: [
          pairedDevice({
            deviceId: "paired-node",
            displayName: "Shared Phone",
            roles: ["node"],
          }),
        ],
      })
      .mockRejectedValueOnce({ message: "unknown requestId", gatewayCode: "INVALID_REQUEST" })
      .mockResolvedValueOnce({
        nodes: [
          {
            nodeId: "paired-node",
            displayName: "Shared Phone",
            approvalState: "pending-approval",
            pendingRequestId: "node-req-display-name",
          },
        ],
      })
      .mockResolvedValueOnce({
        pending: [],
        paired: [
          pairedDevice({
            deviceId: "paired-node",
            displayName: "Shared Phone",
            roles: ["node"],
          }),
        ],
      });

    await runDevicesApprove(["Shared Phone"]);

    expectGatewayCall(2, { method: "node.list" });
    expectGatewayCall(3, { method: "device.pair.list" });
    const errorOutput = readRuntimeErrorOutput();
    expect(errorOutput).toContain("No pending device request matches");
    expect(errorOutput).not.toContain("node-req-display-name");
    expect(errorOutput).not.toContain("openclaw nodes approve");
  });
});

describe("devices cli remove", () => {
  it("removes a paired device by id", async () => {
    callGateway.mockResolvedValueOnce({ deviceId: "device-1" });

    await runDevicesCommand(["remove", "device-1"]);

    expect(callGateway).toHaveBeenCalledTimes(1);
    expectGatewayCall(0, {
      method: "device.pair.remove",
      params: { deviceId: "device-1" },
    });
  });
});

describe("devices cli clear", () => {
  it("requires --yes before clearing", async () => {
    await runDevicesCommand(["clear"]);

    expect(callGateway).not.toHaveBeenCalled();
    expect(runtime.error).toHaveBeenCalledWith("Refusing to clear pairing table without --yes");
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it("clears paired devices and optionally pending requests", async () => {
    callGateway
      .mockResolvedValueOnce({
        paired: [{ deviceId: "device-1" }, { deviceId: "device-2" }],
        pending: [{ requestId: "req-1" }],
      })
      .mockResolvedValueOnce({ deviceId: "device-1" })
      .mockResolvedValueOnce({ deviceId: "device-2" })
      .mockResolvedValueOnce({ requestId: "req-1", deviceId: "device-1" });

    await runDevicesCommand(["clear", "--yes", "--pending"]);

    expectGatewayCall(0, { method: "device.pair.list" });
    expectGatewayCall(1, { method: "device.pair.remove", params: { deviceId: "device-1" } });
    expectGatewayCall(2, { method: "device.pair.remove", params: { deviceId: "device-2" } });
    expectGatewayCall(3, { method: "device.pair.reject", params: { requestId: "req-1" } });
  });
});

describe("devices cli tokens", () => {
  it.each([
    {
      label: "rotates a token for a device role",
      argv: [
        "rotate",
        "--device",
        "device-1",
        "--role",
        "main",
        "--scope",
        "messages:send",
        "--scope",
        "messages:read",
      ],
      expectedCall: {
        method: "device.token.rotate",
        params: {
          deviceId: "device-1",
          role: "main",
          scopes: ["messages:send", "messages:read"],
        },
      },
    },
    {
      label: "revokes a token for a device role",
      argv: ["revoke", "--device", "device-1", "--role", "main"],
      expectedCall: {
        method: "device.token.revoke",
        params: {
          deviceId: "device-1",
          role: "main",
        },
      },
    },
  ])("$label", async ({ argv, expectedCall }) => {
    callGateway.mockResolvedValueOnce({ ok: true });
    await runDevicesCommand(argv);
    expectGatewayCall(0, expectedCall);
  });

  it("rejects blank device or role values", async () => {
    await runDevicesCommand(["rotate", "--device", " ", "--role", "main"]);

    expect(callGateway).not.toHaveBeenCalled();
    expect(readRuntimeErrorOutput()).toContain("--device and --role are required.");
    expect(readRuntimeErrorOutput()).toContain("devices list");
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });
});

describe("devices cli local fallback", () => {
  const fallbackNotice = "Direct scope access failed; using local fallback.";

  it("falls back to local pairing list when gateway returns pairing required on loopback", async () => {
    mockLocalPairingFallback();

    await runDevicesCommand(["list"]);

    expectGatewayCall(0, { method: "device.pair.list" });
    expect(listDevicePairing).toHaveBeenCalledTimes(1);
    expect(readRuntimeOutput()).toContain(fallbackNotice);
  });

  it("falls back to local approve when gateway returns pairing required on loopback", async () => {
    mockLocalPairingFallback();
    rejectGatewayForLocalFallback();
    approveDevicePairing.mockResolvedValueOnce({
      requestId: "req-latest",
      device: {
        deviceId: "device-1",
        publicKey: "pk",
        approvedAtMs: 1,
        createdAtMs: 1,
      },
    });
    summarizeDeviceTokens.mockReturnValue(undefined);

    await runDevicesApprove(["req-latest"]);

    expect(approveDevicePairing).toHaveBeenCalledWith("req-latest", {
      callerScopes: ["operator.admin"],
    });
    expect(readRuntimeOutput()).toContain(fallbackNotice);
    expect(readRuntimeOutput()).toContain("Approved");
  });

  it("approves a same-device compatible replacement request during local fallback", async () => {
    rejectGatewayForLocalFallback("scope upgrade pending approval (requestId: req-new)");
    rejectGatewayForLocalFallback("scope upgrade pending approval (requestId: req-new)");
    listDevicePairing.mockResolvedValueOnce({
      pending: [
        {
          requestId: "req-old",
          deviceId: "device-1",
          publicKey: "pk",
          role: "operator",
          scopes: ["operator.read"],
          clientId: "openclaw-macos",
          clientMode: "cli",
          isRepair: true,
          ts: 1,
        },
        {
          requestId: "req-new",
          deviceId: "device-1",
          publicKey: "pk",
          role: "operator",
          scopes: ["operator.read", "operator.pairing"],
          clientId: "openclaw-macos",
          clientMode: "cli",
          isRepair: true,
          ts: 2,
        },
      ],
      paired: [],
    });
    listDevicePairing.mockResolvedValueOnce({
      pending: [
        {
          requestId: "req-new",
          deviceId: "device-1",
          publicKey: "pk",
          role: "operator",
          scopes: ["operator.read", "operator.pairing"],
          clientId: "openclaw-macos",
          clientMode: "cli",
          isRepair: true,
          ts: 2,
        },
      ],
      paired: [],
    });
    approveDevicePairing.mockResolvedValueOnce({
      requestId: "req-new",
      device: {
        deviceId: "device-1",
        publicKey: "pk",
        approvedAtMs: 1,
        createdAtMs: 1,
      },
    });
    summarizeDeviceTokens.mockReturnValue(undefined);

    await runDevicesApprove(["req-old"]);

    expect(listDevicePairing).toHaveBeenCalledTimes(2);
    expect(approveDevicePairing).toHaveBeenCalledWith("req-new", {
      callerScopes: ["operator.admin"],
    });
    expect(readRuntimeOutput()).toContain(fallbackNotice);
    expect(readRuntimeOutput()).toContain(
      "Pending request req-old was replaced by same-device repair req-new; approving latest compatible request.",
    );
    expect(readRuntimeOutput()).toContain("(req-new)");
  });

  it("emits resolved metadata in JSON mode when local fallback approves a replacement request", async () => {
    rejectGatewayForLocalFallback("scope upgrade pending approval (requestId: req-new)");
    rejectGatewayForLocalFallback("scope upgrade pending approval (requestId: req-new)");
    listDevicePairing
      .mockResolvedValueOnce({
        pending: [
          {
            requestId: "req-old",
            deviceId: "device-1",
            publicKey: "pk",
            role: "operator",
            scopes: ["operator.read"],
            clientId: "openclaw-macos",
            clientMode: "cli",
            isRepair: true,
            ts: 1,
          },
          {
            requestId: "req-new",
            deviceId: "device-1",
            publicKey: "pk",
            role: "operator",
            scopes: ["operator.read", "operator.pairing"],
            clientId: "openclaw-macos",
            clientMode: "cli",
            isRepair: true,
            ts: 2,
          },
        ],
        paired: [],
      })
      .mockResolvedValueOnce({
        pending: [
          {
            requestId: "req-new",
            deviceId: "device-1",
            publicKey: "pk",
            role: "operator",
            scopes: ["operator.read", "operator.pairing"],
            clientId: "openclaw-macos",
            clientMode: "cli",
            isRepair: true,
            ts: 2,
          },
        ],
        paired: [],
      });
    approveDevicePairing.mockResolvedValueOnce({
      requestId: "req-new",
      device: {
        deviceId: "device-1",
        publicKey: "pk",
        approvedAtMs: 1,
        createdAtMs: 1,
      },
    });

    await runDevicesApprove(["req-old", "--json"]);

    expect(runtime.writeJson).toHaveBeenCalledWith({
      requestId: "req-new",
      resolved: {
        kind: "same-device-replacement",
        requestedRequestId: "req-old",
        approvedRequestId: "req-new",
      },
      device: {
        deviceId: "device-1",
        publicKey: "pk",
        approvedAtMs: 1,
        createdAtMs: 1,
        tokens: undefined,
      },
    });
    expect(runtime.log).not.toHaveBeenCalledWith(
      expect.stringContaining("Pending request req-old was replaced"),
    );
  });

  it("approves a replacement request when the original repair inherited scopes from the paired token", async () => {
    rejectGatewayForLocalFallback("scope upgrade pending approval (requestId: req-new)");
    rejectGatewayForLocalFallback("scope upgrade pending approval (requestId: req-new)");
    listDevicePairing
      .mockResolvedValueOnce({
        pending: [
          {
            requestId: "req-old",
            deviceId: "device-1",
            publicKey: "pk",
            role: "operator",
            scopes: [],
            clientId: "openclaw-macos",
            clientMode: "cli",
            isRepair: true,
            ts: 1,
          },
          {
            requestId: "req-new",
            deviceId: "device-1",
            publicKey: "pk",
            role: "operator",
            scopes: ["operator.read", "operator.pairing"],
            clientId: "openclaw-macos",
            clientMode: "cli",
            isRepair: true,
            ts: 2,
          },
        ],
        paired: [
          {
            deviceId: "device-1",
            publicKey: "pk",
            roles: ["operator"],
            scopes: ["operator.read"],
            tokens: [{ role: "operator", scopes: ["operator.read"] }],
          },
        ],
      })
      .mockResolvedValueOnce({
        pending: [
          {
            requestId: "req-new",
            deviceId: "device-1",
            publicKey: "pk",
            role: "operator",
            scopes: ["operator.read", "operator.pairing"],
            clientId: "openclaw-macos",
            clientMode: "cli",
            isRepair: true,
            ts: 2,
          },
        ],
        paired: [
          {
            deviceId: "device-1",
            publicKey: "pk",
            roles: ["operator"],
            scopes: ["operator.read"],
            tokens: [{ role: "operator", scopes: ["operator.read"] }],
          },
        ],
      });
    approveDevicePairing.mockResolvedValueOnce({
      requestId: "req-new",
      device: {
        deviceId: "device-1",
        publicKey: "pk",
        approvedAtMs: 1,
        createdAtMs: 1,
      },
    });

    await runDevicesApprove(["req-old"]);

    expect(approveDevicePairing).toHaveBeenCalledWith("req-new", {
      callerScopes: ["operator.admin"],
    });
    expect(readRuntimeOutput()).toContain(
      "Pending request req-old was replaced by same-device repair req-new; approving latest compatible request.",
    );
  });

  it("fails closed when the original request snapshot is missing", async () => {
    rejectGatewayForLocalFallback("scope upgrade pending approval (requestId: req-new)");
    rejectGatewayForLocalFallback("scope upgrade pending approval (requestId: req-new)");
    listDevicePairing
      .mockResolvedValueOnce({
        pending: [
          {
            requestId: "req-new",
            deviceId: "device-1",
            publicKey: "pk",
            role: "operator",
            scopes: ["operator.read", "operator.pairing"],
            clientId: "openclaw-macos",
            clientMode: "cli",
            isRepair: true,
            ts: 2,
          },
        ],
        paired: [],
      })
      .mockResolvedValueOnce({
        pending: [
          {
            requestId: "req-new",
            deviceId: "device-1",
            publicKey: "pk",
            role: "operator",
            scopes: ["operator.read", "operator.pairing"],
            clientId: "openclaw-macos",
            clientMode: "cli",
            isRepair: true,
            ts: 2,
          },
        ],
        paired: [],
      });

    await expect(runDevicesApprove(["req-old"])).rejects.toThrow(
      "local fallback pairing state does not contain the gateway request",
    );
    expect(approveDevicePairing).not.toHaveBeenCalled();
  });

  it("fails closed when the replacement request is not a compatible scope superset", async () => {
    rejectGatewayForLocalFallback("scope upgrade pending approval (requestId: req-new)");
    rejectGatewayForLocalFallback("scope upgrade pending approval (requestId: req-new)");
    listDevicePairing
      .mockResolvedValueOnce({
        pending: [
          {
            requestId: "req-old",
            deviceId: "device-1",
            publicKey: "pk",
            role: "operator",
            scopes: ["operator.read", "operator.write"],
            clientId: "openclaw-macos",
            clientMode: "cli",
            isRepair: true,
            ts: 1,
          },
          {
            requestId: "req-new",
            deviceId: "device-1",
            publicKey: "pk",
            role: "operator",
            scopes: ["operator.pairing"],
            clientId: "openclaw-macos",
            clientMode: "cli",
            isRepair: true,
            ts: 2,
          },
        ],
        paired: [],
      })
      .mockResolvedValueOnce({
        pending: [
          {
            requestId: "req-new",
            deviceId: "device-1",
            publicKey: "pk",
            role: "operator",
            scopes: ["operator.pairing"],
            clientId: "openclaw-macos",
            clientMode: "cli",
            isRepair: true,
            ts: 2,
          },
        ],
        paired: [],
      });

    await expect(runDevicesApprove(["req-old"])).rejects.toThrow(
      "local fallback pairing state does not contain the gateway request",
    );
    expect(approveDevicePairing).not.toHaveBeenCalled();
  });

  it("fails closed when the replacement request adds unrelated broader scopes", async () => {
    rejectGatewayForLocalFallback("scope upgrade pending approval (requestId: req-new)");
    rejectGatewayForLocalFallback("scope upgrade pending approval (requestId: req-new)");
    listDevicePairing
      .mockResolvedValueOnce({
        pending: [
          {
            requestId: "req-old",
            deviceId: "device-1",
            publicKey: "pk",
            role: "operator",
            scopes: ["operator.read"],
            clientId: "openclaw-macos",
            clientMode: "cli",
            isRepair: true,
            ts: 1,
          },
          {
            requestId: "req-new",
            deviceId: "device-1",
            publicKey: "pk",
            role: "operator",
            scopes: ["operator.read", "operator.write"],
            clientId: "openclaw-macos",
            clientMode: "cli",
            isRepair: true,
            ts: 2,
          },
        ],
        paired: [],
      })
      .mockResolvedValueOnce({
        pending: [
          {
            requestId: "req-new",
            deviceId: "device-1",
            publicKey: "pk",
            role: "operator",
            scopes: ["operator.read", "operator.write"],
            clientId: "openclaw-macos",
            clientMode: "cli",
            isRepair: true,
            ts: 2,
          },
        ],
        paired: [],
      });

    await expect(runDevicesApprove(["req-old"])).rejects.toThrow(
      "local fallback pairing state does not contain the gateway request",
    );
    expect(approveDevicePairing).not.toHaveBeenCalled();
  });

  it("fails closed when the replacement request belongs to a different device", async () => {
    rejectGatewayForLocalFallback("scope upgrade pending approval (requestId: req-new)");
    rejectGatewayForLocalFallback("scope upgrade pending approval (requestId: req-new)");
    listDevicePairing
      .mockResolvedValueOnce({
        pending: [
          {
            requestId: "req-old",
            deviceId: "device-1",
            publicKey: "pk",
            role: "operator",
            scopes: ["operator.read"],
            clientId: "openclaw-macos",
            clientMode: "cli",
            isRepair: true,
            ts: 1,
          },
          {
            requestId: "req-new",
            deviceId: "device-2",
            publicKey: "pk",
            role: "operator",
            scopes: ["operator.read", "operator.pairing"],
            clientId: "openclaw-macos",
            clientMode: "cli",
            isRepair: true,
            ts: 2,
          },
        ],
        paired: [],
      })
      .mockResolvedValueOnce({
        pending: [
          {
            requestId: "req-new",
            deviceId: "device-2",
            publicKey: "pk",
            role: "operator",
            scopes: ["operator.read", "operator.pairing"],
            clientId: "openclaw-macos",
            clientMode: "cli",
            isRepair: true,
            ts: 2,
          },
        ],
        paired: [],
      });

    await expect(runDevicesApprove(["req-old"])).rejects.toThrow(
      "local fallback pairing state does not contain the gateway request",
    );
    expect(approveDevicePairing).not.toHaveBeenCalled();
  });

  it("fails closed when the replacement request has a different public key", async () => {
    rejectGatewayForLocalFallback("scope upgrade pending approval (requestId: req-new)");
    rejectGatewayForLocalFallback("scope upgrade pending approval (requestId: req-new)");
    listDevicePairing
      .mockResolvedValueOnce({
        pending: [
          {
            requestId: "req-old",
            deviceId: "device-1",
            publicKey: "pk-old",
            role: "operator",
            scopes: ["operator.read"],
            clientId: "openclaw-macos",
            clientMode: "cli",
            isRepair: true,
            ts: 1,
          },
          {
            requestId: "req-new",
            deviceId: "device-1",
            publicKey: "pk-new",
            role: "operator",
            scopes: ["operator.read", "operator.pairing"],
            clientId: "openclaw-macos",
            clientMode: "cli",
            isRepair: true,
            ts: 2,
          },
        ],
        paired: [],
      })
      .mockResolvedValueOnce({
        pending: [
          {
            requestId: "req-new",
            deviceId: "device-1",
            publicKey: "pk-new",
            role: "operator",
            scopes: ["operator.read", "operator.pairing"],
            clientId: "openclaw-macos",
            clientMode: "cli",
            isRepair: true,
            ts: 2,
          },
        ],
        paired: [],
      });

    await expect(runDevicesApprove(["req-old"])).rejects.toThrow(
      "local fallback pairing state does not contain the gateway request",
    );
    expect(approveDevicePairing).not.toHaveBeenCalled();
  });

  it("fails closed when the replacement request changes the requested role set", async () => {
    rejectGatewayForLocalFallback("scope upgrade pending approval (requestId: req-new)");
    rejectGatewayForLocalFallback("scope upgrade pending approval (requestId: req-new)");
    listDevicePairing
      .mockResolvedValueOnce({
        pending: [
          {
            requestId: "req-old",
            deviceId: "device-1",
            publicKey: "pk",
            role: "operator",
            scopes: ["operator.read"],
            clientId: "openclaw-macos",
            clientMode: "cli",
            isRepair: true,
            ts: 1,
          },
          {
            requestId: "req-new",
            deviceId: "device-1",
            publicKey: "pk",
            roles: ["operator", "different-role"],
            scopes: ["operator.read", "operator.pairing"],
            clientId: "openclaw-macos",
            clientMode: "cli",
            isRepair: true,
            ts: 2,
          },
        ],
        paired: [],
      })
      .mockResolvedValueOnce({
        pending: [
          {
            requestId: "req-new",
            deviceId: "device-1",
            publicKey: "pk",
            roles: ["operator", "different-role"],
            scopes: ["operator.read", "operator.pairing"],
            clientId: "openclaw-macos",
            clientMode: "cli",
            isRepair: true,
            ts: 2,
          },
        ],
        paired: [],
      });

    await expect(runDevicesApprove(["req-old"])).rejects.toThrow(
      "local fallback pairing state does not contain the gateway request",
    );
    expect(approveDevicePairing).not.toHaveBeenCalled();
  });

  it("fails closed when the replacement request conflicts with client metadata", async () => {
    rejectGatewayForLocalFallback("scope upgrade pending approval (requestId: req-new)");
    rejectGatewayForLocalFallback("scope upgrade pending approval (requestId: req-new)");
    listDevicePairing
      .mockResolvedValueOnce({
        pending: [
          {
            requestId: "req-old",
            deviceId: "device-1",
            publicKey: "pk",
            role: "operator",
            scopes: ["operator.read"],
            clientId: "openclaw-macos",
            clientMode: "cli",
            isRepair: true,
            ts: 1,
          },
          {
            requestId: "req-new",
            deviceId: "device-1",
            publicKey: "pk",
            role: "operator",
            scopes: ["operator.read", "operator.pairing"],
            clientId: "openclaw-ios",
            clientMode: "agent",
            isRepair: true,
            ts: 2,
          },
        ],
        paired: [],
      })
      .mockResolvedValueOnce({
        pending: [
          {
            requestId: "req-new",
            deviceId: "device-1",
            publicKey: "pk",
            role: "operator",
            scopes: ["operator.read", "operator.pairing"],
            clientId: "openclaw-ios",
            clientMode: "agent",
            isRepair: true,
            ts: 2,
          },
        ],
        paired: [],
      });

    await expect(runDevicesApprove(["req-old"])).rejects.toThrow(
      "local fallback pairing state does not contain the gateway request",
    );
    expect(approveDevicePairing).not.toHaveBeenCalled();
  });

  it("explains how to recover when neither the original nor replacement request remains pending", async () => {
    rejectGatewayForLocalFallback("scope upgrade pending approval (requestId: req-new)");
    rejectGatewayForLocalFallback("scope upgrade pending approval (requestId: req-new)");
    listDevicePairing
      .mockResolvedValueOnce({
        pending: [
          {
            requestId: "req-old",
            deviceId: "device-1",
            publicKey: "pk",
            role: "operator",
            scopes: ["operator.read"],
            clientId: "openclaw-macos",
            clientMode: "cli",
            isRepair: true,
            ts: 1,
          },
          {
            requestId: "req-new",
            deviceId: "device-1",
            publicKey: "pk",
            role: "operator",
            scopes: ["operator.read", "operator.pairing"],
            clientId: "openclaw-macos",
            clientMode: "cli",
            isRepair: true,
            ts: 2,
          },
        ],
        paired: [],
      })
      .mockResolvedValueOnce({
        pending: [],
        paired: [],
      });

    await runDevicesApprove(["req-old"]);

    const errorOutput = stripAnsi(readRuntimeErrorOutput());
    expect(errorOutput).toContain("No pending device request matches req-old");
    expect(errorOutput).toContain("openclaw devices list");
    expect(errorOutput).not.toContain("unknown requestId");
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(approveDevicePairing).not.toHaveBeenCalled();
  });

  it("explains how to approve an upgrade from another device", async () => {
    // Explicit --url disables the loopback local fallback, so the scope-upgrade
    // denial propagates as the authorization error the user must resolve. The
    // first rejection is consumed by the pre-approve context lookup, the second
    // by the approve call itself.
    rejectGatewayForLocalFallback("scope upgrade pending approval (requestId: req-remote)");
    rejectGatewayForLocalFallback("scope upgrade pending approval (requestId: req-remote)");

    await runDevicesApprove(["req-remote", "--url", "wss://gateway.example.com/ws"]);

    const errorOutput = stripAnsi(readRuntimeErrorOutput());
    expect(errorOutput).toContain("can't approve its own scope upgrade");
    expect(errorOutput).toContain("Control UI");
    expect(errorOutput).toContain("another authorized device");
    expect(errorOutput).not.toContain("--token");
    expect(errorOutput).not.toContain("--password");
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it("falls back to local pairing list when gateway returns a scope upgrade message on loopback", async () => {
    mockLocalPairingFallback("scope upgrade pending approval (requestId: req-1)");

    await runDevicesCommand(["list"]);

    expect(listDevicePairing).toHaveBeenCalledTimes(1);
    expect(readRuntimeOutput()).toContain(fallbackNotice);
  });

  it("refuses local fallback when the gateway request is absent from local pairing state", async () => {
    rejectGatewayForLocalFallback("scope upgrade pending approval (requestId: req-profile)");
    listDevicePairing.mockResolvedValueOnce({
      pending: [{ requestId: "req-default", deviceId: "device-1", publicKey: "pk", ts: 1 }],
      paired: [],
    });
    summarizeDeviceTokens.mockReturnValue(undefined);

    await expect(runDevicesCommand(["list"])).rejects.toThrow(
      "different OPENCLAW_PROFILE or OPENCLAW_STATE_DIR",
    );
    expect(readRuntimeOutput()).not.toContain(fallbackNotice);
  });

  it("keeps the mismatch error when the gateway request itself is absent locally", async () => {
    rejectGatewayForLocalFallback("device pairing required (requestId: req-profile)");
    rejectGatewayForLocalFallback("device pairing required (requestId: req-profile)");
    approveDevicePairing.mockResolvedValueOnce(undefined);

    await expect(runDevicesApprove(["req-profile"])).rejects.toThrow(
      "local fallback pairing state does not contain the gateway request",
    );
    expect(readRuntimeOutput()).not.toContain(fallbackNotice);
  });

  it("explains recovery instead of approving a different local request", async () => {
    rejectGatewayForLocalFallback("device pairing required (requestId: req-profile)");
    rejectGatewayForLocalFallback("device pairing required (requestId: req-profile)");

    await runDevicesApprove(["req-default"]);

    expect(approveDevicePairing).not.toHaveBeenCalled();
    const errorOutput = stripAnsi(readRuntimeErrorOutput());
    expect(errorOutput).toContain("No pending device request matches req-default");
    expect(errorOutput).toContain("openclaw devices list");
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it("does not use local fallback when an explicit --url is provided", async () => {
    rejectGatewayForLocalFallback();

    await expect(
      runDevicesCommand(["list", "--json", "--url", "ws://127.0.0.1:18789"]),
    ).rejects.toThrow("pairing required");
    expect(listDevicePairing).not.toHaveBeenCalled();
  });
});

describe("devices cli list", () => {
  it("renders requested versus approved access for pending upgrades", async () => {
    mockGatewayPairingList({ scopes: ["operator.admin", "operator.read"] });

    await runDevicesCommand(["list"]);

    const output = readRuntimeOutput();
    expect(output).toContain("Requested");
    expect(output).toContain("Approved");
    expect(output).toContain("operator.write");
    expect(output).toContain("operator.read");
    expect(output).toContain("scope upgrade");
  });

  it("normalizes pending device ids before matching paired approvals", async () => {
    mockGatewayPairingList({ deviceId: " device-1 " });

    await runDevicesCommand(["list"]);

    const output = readRuntimeOutput();
    expect(output).toContain("scope upgrade");
    expect(output).toContain("operator.read");
  });

  it("shows pending node approval commands for paired node devices", async () => {
    callGateway
      .mockResolvedValueOnce({
        pending: [],
        paired: [
          pairedDevice({
            deviceId: "android-node",
            displayName: "Colin's S25",
            remoteIp: "192.168.0.202",
            role: "node",
            roles: [],
          }),
        ],
      })
      .mockResolvedValueOnce({
        nodes: [
          {
            nodeId: "android-node",
            displayName: "Colin's S25",
            remoteIp: "192.168.0.202",
            approvalState: "pending-reapproval",
            pendingRequestId: "node-req-1",
          },
        ],
      });

    await runDevicesCommand([
      "list",
      "--url",
      "ws://gateway-user:url-secret@gateway.example:18789/openclaw?cluster=qa",
      "--token",
      "secret-token",
    ]);

    expectGatewayCall(1, { method: "node.list" });
    const output = readRuntimeOutput();
    expect(output).toContain("Node reapproval pending for Colin's S25");
    expect(output).toContain("openclaw nodes approve node-req-1");
    expect(output).toContain("Reuse the same connection options when rerunning: --url, --token.");
    expect(output).not.toContain("gateway-user");
    expect(output).not.toContain("url-secret");
    expect(output).not.toContain("gateway.example");
    expect(output).not.toContain("secret-token");
  });

  it("does not show node approval commands for paired node devices when only display names match", async () => {
    callGateway
      .mockResolvedValueOnce({
        pending: [],
        paired: [
          pairedDevice({
            deviceId: "android-node",
            displayName: "Shared Phone",
            remoteIp: "192.168.0.202",
            role: "node",
            roles: [],
          }),
        ],
      })
      .mockResolvedValueOnce({
        nodes: [
          {
            nodeId: "unrelated-node",
            displayName: "Shared Phone",
            remoteIp: "10.0.0.50",
            approvalState: "pending-reapproval",
            pendingRequestId: "node-req-unrelated",
          },
        ],
      });

    await runDevicesCommand(["list"]);

    expectGatewayCall(1, { method: "node.list" });
    const output = readRuntimeOutput();
    expect(output).not.toContain("node-req-unrelated");
    expect(output).not.toContain("openclaw nodes approve");
  });

  it("does not show upgrade context for key-mismatched pending requests", async () => {
    mockGatewayPairingList({ publicKey: "new-key" }, { publicKey: "old-key" });

    await runDevicesCommand(["list"]);

    const output = readRuntimeOutput();
    expect(output).toContain("new pairing");
    expect(output).not.toContain("scope upgrade");
    expect(output).not.toContain("roles: operator; scopes: operator.read");
  });

  it("sanitizes device-controlled terminal output", async () => {
    callGateway.mockResolvedValueOnce({
      pending: [
        {
          requestId: "req-1",
          deviceId: "device-1",
          displayName: "Bad\u001b[2J\nName",
          role: "operator",
          scopes: ["operator.admin"],
          remoteIp: "10.0.0.9\rspoof",
          ts: 1,
        },
      ],
      paired: [
        {
          deviceId: "device-1",
          displayName: "Pair\u001b]8;;https://evil.example\u001b\\ed",
          roles: ["operator"],
          scopes: ["operator.read"],
          remoteIp: "10.0.0.1\u007f",
        },
      ],
    });

    await runDevicesCommand(["list"]);

    const output = stripAnsi(readRuntimeOutput());
    expect(output).not.toContain("\u001b");
    expect(output).not.toContain("\r");
    expect(output).toContain("BadName");
    expect(output).toContain("spoof");
    expect(output).toContain("Paired");
  });

  it("emits JSON when the gateway transport fails in JSON mode", async () => {
    const error = new Error("gateway closed (1006)");
    const payload = {
      ok: false,
      error: {
        type: "gateway_transport_error",
        kind: "closed",
        message: "gateway closed (1006)",
      },
      gateway: {
        url: "ws://127.0.0.1:18789",
        urlSource: "local loopback",
      },
    };
    callGateway.mockRejectedValueOnce(error);
    formatGatewayTransportErrorJson.mockReturnValueOnce(payload);

    await runDevicesCommand(["list", "--json"]);

    expect(formatGatewayTransportErrorJson).toHaveBeenCalledWith(error);
    expect(runtime.writeJson).toHaveBeenCalledWith(payload);
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it("renders paired devices with operatorLabel then displayName then clientId precedence", async () => {
    callGateway.mockResolvedValueOnce({
      pending: [],
      paired: [
        pairedDevice({
          deviceId: "dev-label",
          operatorLabel: "Kitchen Mac",
          displayName: "MacBook Pro",
          clientId: "openclaw-macos",
        }),
        pairedDevice({
          deviceId: "dev-display",
          displayName: "Living Room iPad",
          clientId: "openclaw-ios",
        }),
        pairedDevice({
          deviceId: "dev-client",
          clientId: "openclaw-control-ui",
          displayName: undefined,
        }),
        pairedDevice({
          deviceId: "dev-id-only",
          displayName: undefined,
        }),
      ],
    });

    await runDevicesCommand(["list"]);

    const output = stripAnsi(readRuntimeOutput());
    expect(output).toContain("Kitchen Mac");
    expect(output).toContain("Living Room iPad");
    expect(output).toContain("openclaw-control-ui");
    expect(output).toContain("dev-id-only");
    expect(output).not.toContain("MacBook Pro");
    expect(output).not.toContain("openclaw-macos");
    expect(output).not.toContain("openclaw-ios");
  });
});

describe("devices cli rename", () => {
  it("renames a paired device via device.pair.rename", async () => {
    callGateway.mockResolvedValueOnce({ deviceId: "device-1", label: "Kitchen Mac" });

    await runDevicesCommand(["rename", "--device", "device-1", "--name", "Kitchen Mac"]);

    expectGatewayCall(0, {
      method: "device.pair.rename",
      params: { deviceId: "device-1", label: "Kitchen Mac" },
    });
    expect(stripAnsi(readRuntimeOutput())).toContain("Kitchen Mac");
  });
});

beforeEach(() => {
  vi.clearAllMocks();
  runtime.exit.mockImplementation(() => {});
  formatGatewayTransportErrorJson.mockReturnValue(null);
});

afterEach(() => {
  buildGatewayConnectionDetails.mockReturnValue({
    url: "ws://127.0.0.1:18789",
    urlSource: "local loopback",
    message: "",
  });
  listDevicePairing.mockResolvedValue({ pending: [], paired: [] });
  approveDevicePairing.mockResolvedValue(undefined);
  summarizeDeviceTokens.mockReturnValue(undefined);
});
