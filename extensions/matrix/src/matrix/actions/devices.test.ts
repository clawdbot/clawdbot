import { beforeEach, describe, expect, it, vi } from "vitest";

const withResolvedActionClientMock = vi.fn();
const withStartedActionClientMock = vi.fn();

vi.mock("./client.js", () => ({
  withResolvedActionClient: (...args: unknown[]) => withResolvedActionClientMock(...args),
  withStartedActionClient: (...args: unknown[]) => withStartedActionClientMock(...args),
}));

const { getMatrixDeviceHealth, listMatrixOwnDevices, pruneMatrixStaleGatewayDevices } =
  await import("./devices.js");

function expectResolvedActionClientCall(): void {
  expect(withResolvedActionClientMock).toHaveBeenCalledTimes(1);
  const call = withResolvedActionClientMock.mock.calls.at(0);
  if (!call) {
    throw new Error("Expected resolved action client call");
  }
  expect(call[0]).toEqual({ accountId: "poe" });
  expect(call[1]).toBeTypeOf("function");
  expect(withStartedActionClientMock).not.toHaveBeenCalled();
}

describe("matrix device actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("lists own devices without starting a sync client", async () => {
    withResolvedActionClientMock.mockImplementation(async (_opts, run) => {
      return await run({
        listOwnDevices: vi.fn(async () => [
          {
            deviceId: "A7hWrQ70ea",
            displayName: "OpenClaw Gateway",
            lastSeenIp: null,
            lastSeenTs: null,
            current: true,
          },
        ]),
      });
    });

    const result = await listMatrixOwnDevices({ accountId: "poe" });

    expectResolvedActionClientCall();
    expect(result).toEqual([
      {
        deviceId: "A7hWrQ70ea",
        displayName: "OpenClaw Gateway",
        lastSeenIp: null,
        lastSeenTs: null,
        current: true,
      },
    ]);
  });

  it("computes device health without starting a sync client", async () => {
    withResolvedActionClientMock.mockImplementation(async (_opts, run) => {
      return await run({
        listOwnDevices: vi.fn(async () => [
          {
            deviceId: "du314Zpw3A",
            displayName: "OpenClaw Gateway",
            lastSeenIp: null,
            lastSeenTs: null,
            current: true,
          },
          {
            deviceId: "old123",
            displayName: "OpenClaw Gateway",
            lastSeenIp: null,
            lastSeenTs: null,
            current: false,
          },
        ]),
      });
    });

    const result = await getMatrixDeviceHealth({ accountId: "poe" });

    expect(result).toEqual({
      currentDeviceId: "du314Zpw3A",
      staleOpenClawDevices: [
        {
          deviceId: "old123",
          displayName: "OpenClaw Gateway",
          lastSeenIp: null,
          lastSeenTs: null,
          current: false,
        },
      ],
      currentOpenClawDevices: [
        {
          deviceId: "du314Zpw3A",
          displayName: "OpenClaw Gateway",
          lastSeenIp: null,
          lastSeenTs: null,
          current: true,
        },
      ],
    });
    expectResolvedActionClientCall();
  });

  it("prunes stale OpenClaw-managed devices but preserves the current device", async () => {
    const deleteOwnDevices = vi.fn(async () => ({
      currentDeviceId: "du314Zpw3A",
      deletedDeviceIds: ["BritdXC6iL", "G6NJU9cTgs", "My3T0hkTE0"],
      remainingDevices: [
        {
          deviceId: "du314Zpw3A",
          displayName: "OpenClaw Gateway",
          lastSeenIp: null,
          lastSeenTs: null,
          current: true,
        },
      ],
    }));
    withResolvedActionClientMock.mockImplementation(async (_opts, run) => {
      return await run({
        listOwnDevices: vi.fn(async () => [
          {
            deviceId: "du314Zpw3A",
            displayName: "OpenClaw Gateway",
            lastSeenIp: null,
            lastSeenTs: null,
            current: true,
          },
          {
            deviceId: "BritdXC6iL",
            displayName: "OpenClaw Gateway",
            lastSeenIp: null,
            lastSeenTs: null,
            current: false,
          },
          {
            deviceId: "G6NJU9cTgs",
            displayName: "OpenClaw Debug",
            lastSeenIp: null,
            lastSeenTs: null,
            current: false,
          },
          {
            deviceId: "My3T0hkTE0",
            displayName: "OpenClaw Gateway",
            lastSeenIp: null,
            lastSeenTs: null,
            current: false,
          },
          {
            deviceId: "phone123",
            displayName: "Element iPhone",
            lastSeenIp: null,
            lastSeenTs: null,
            current: false,
          },
        ]),
        deleteOwnDevices,
      });
    });

    const result = await pruneMatrixStaleGatewayDevices({ accountId: "poe" });

    expect(deleteOwnDevices).toHaveBeenCalledWith(["BritdXC6iL", "G6NJU9cTgs", "My3T0hkTE0"]);
    expect(result).toEqual({
      before: [
        {
          deviceId: "du314Zpw3A",
          displayName: "OpenClaw Gateway",
          lastSeenIp: null,
          lastSeenTs: null,
          current: true,
        },
        {
          deviceId: "BritdXC6iL",
          displayName: "OpenClaw Gateway",
          lastSeenIp: null,
          lastSeenTs: null,
          current: false,
        },
        {
          deviceId: "G6NJU9cTgs",
          displayName: "OpenClaw Debug",
          lastSeenIp: null,
          lastSeenTs: null,
          current: false,
        },
        {
          deviceId: "My3T0hkTE0",
          displayName: "OpenClaw Gateway",
          lastSeenIp: null,
          lastSeenTs: null,
          current: false,
        },
        {
          deviceId: "phone123",
          displayName: "Element iPhone",
          lastSeenIp: null,
          lastSeenTs: null,
          current: false,
        },
      ],
      staleGatewayDeviceIds: ["BritdXC6iL", "G6NJU9cTgs", "My3T0hkTE0"],
      currentDeviceId: "du314Zpw3A",
      deletedDeviceIds: ["BritdXC6iL", "G6NJU9cTgs", "My3T0hkTE0"],
      remainingDevices: [
        {
          deviceId: "du314Zpw3A",
          displayName: "OpenClaw Gateway",
          lastSeenIp: null,
          lastSeenTs: null,
          current: true,
        },
      ],
    });
    expectResolvedActionClientCall();
  });
});
