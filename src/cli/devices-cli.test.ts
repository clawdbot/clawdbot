import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerDevicesCli } from "./devices-cli.js";

const mocks = vi.hoisted(() => ({
  runtime: {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
    writeJson: vi.fn(),
  },
  callGateway: vi.fn(),
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
  buildGatewayConnectionDetails,
  listDevicePairing,
  approveDevicePairing,
  summarizeDeviceTokens,
} = mocks;

vi.mock("../gateway/call.js", () => ({
  callGateway: mocks.callGateway,
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
    expect(callGateway).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        method: "device.pair.list",
      }),
    );
    expect(callGateway).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        method: "device.pair.approve",
        params: { requestId: "req-123" },
        scopes: ["operator.admin"],
      }),
    );
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

    expect(callGateway).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        method: "device.pair.approve",
        params: { requestId: "req-pairing" },
        scopes: ["operator.pairing"],
      }),
    );
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
    expect(callGateway).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        method: "device.pair.approve",
        params: { requestId: "req-cross-device" },
        scopes: undefined,
      }),
    );
    expect(callGateway).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        method: "device.pair.approve",
        params: { requestId: "req-cross-device" },
        scopes: ["operator.admin"],
      }),
    );
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

    expect(callGateway).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        method: "device.pair.approve",
        params: { requestId: "req-repair" },
        scopes: ["operator.admin"],
      }),
    );
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
    expect(callGateway).toHaveBeenCalledWith(
      expect.objectContaining({ method: "device.pair.list" }),
    );
    const logOutput = runtime.log.mock.calls.map((c) => readRuntimeCallText(c)).join("\n");
    expect(logOutput).toContain("req-abc");
    expect(logOutput).toContain("Device Nine");
    expect(logOutput).toContain("Approved: roles: operator; scopes: operator.read");
    expect(logOutput).toContain("Requested scopes exceed the current approval");
    expect(runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("openclaw devices approve req-abc"),
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(callGateway).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: "device.pair.approve" }),
    );
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

    expect(callGateway).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ method: "device.pair.list" }),
    );
    expect(callGateway).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: "device.pair.approve" }),
    );
    expect(runtime.error).toHaveBeenCalledWith(
      expect.stringContaining(`openclaw devices approve ${expectedRequestId}`),
    );
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
    expect(runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("openclaw devices approve req-blank"),
    );
    expect(callGateway).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: "device.pair.approve" }),
    );
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
    expect(callGateway).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: "device.pair.approve" }),
    );
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
    expect(callGateway).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: "device.pair.approve" }),
    );
  });

  it("prints an error and exits when no pending requests are available", async () => {
    callGateway.mockResolvedValueOnce({ pending: [] });

    await runDevicesApprove([]);

    expect(callGateway).toHaveBeenCalledTimes(1);
    expect(callGateway).toHaveBeenCalledWith(
      expect.objectContaining({ method: "device.pair.list" }),
    );
    expect(runtime.error).toHaveBeenCalledWith("No pending device pairing requests to approve");
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(callGateway).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: "device.pair.approve" }),
    );
  });
});

describe("devices cli remove", () => {
  it("removes a paired device by id", async () => {
    callGateway.mockResolvedValueOnce({ deviceId: "device-1" });

    await runDevicesCommand(["remove", "device-1"]);

    expect(callGateway).toHaveBeenCalledTimes(1);
    expect(callGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "device.pair.remove",
        params: { deviceId: "device-1" },
      }),
    );
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

    expect(callGateway).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ method: "device.pair.list" }),
    );
    expect(callGateway).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ method: "device.pair.remove", params: { deviceId: "device-1" } }),
    );
    expect(callGateway).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ method: "device.pair.remove", params: { deviceId: "device-2" } }),
    );
    expect(callGateway).toHaveBeenNthCalledWith(
      4,
      expect.objectContaining({ method: "device.pair.reject", params: { requestId: "req-1" } }),
    );
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
    expect(callGateway).toHaveBeenCalledWith(expect.objectContaining(expectedCall));
  });

  it("rejects blank device or role values", async () => {
    await runDevicesCommand(["rotate", "--device", " ", "--role", "main"]);

    expect(callGateway).not.toHaveBeenCalled();
    expect(runtime.error).toHaveBeenCalledWith("--device and --role required");
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });
});

describe("devices cli local fallback", () => {
  const fallbackNotice = "Direct scope access failed; using local fallback.";

  it("falls back to local pairing list when gateway returns pairing required on loopback", async () => {
    mockLocalPairingFallback();

    await runDevicesCommand(["list"]);

    expect(callGateway).toHaveBeenCalledWith(
      expect.objectContaining({ method: "device.pair.list" }),
    );
    expect(listDevicePairing).toHaveBeenCalledTimes(1);
    expect(runtime.log).toHaveBeenCalledWith(expect.stringContaining(fallbackNotice));
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
    expect(runtime.log).toHaveBeenCalledWith(expect.stringContaining(fallbackNotice));
    expect(runtime.log).toHaveBeenCalledWith(expect.stringContaining("Approved"));
  });

  it("falls back to local pairing list when gateway returns a scope upgrade message on loopback", async () => {
    mockLocalPairingFallback("scope upgrade pending approval (requestId: req-123)");

    await runDevicesCommand(["list"]);

    expect(listDevicePairing).toHaveBeenCalledTimes(1);
    expect(runtime.log).toHaveBeenCalledWith(expect.stringContaining(fallbackNotice));
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

    const output = readRuntimeOutput();
    expect(output).not.toContain("\u001b");
    expect(output).not.toContain("\r");
    expect(output).toContain("BadName");
    expect(output).toContain("spoof");
    expect(output).toContain("Paired");
  });
});

beforeEach(() => {
  vi.clearAllMocks();
  runtime.exit.mockImplementation(() => {});
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
