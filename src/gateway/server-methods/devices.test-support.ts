import { expect, vi } from "vitest";
import {
  onInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
  type DiagnosticSecurityEvent,
} from "../../infra/diagnostic-events.js";
import { runNodeWakeAttempt, runNodeWakeNudgeAttempt } from "../node-wake-state.js";
import { resetNodeWakeStateForTest } from "../node-wake-state.test-support.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

const {
  approveDevicePairingMock,
  getPairedDeviceMock,
  getPendingDevicePairingMock,
  listDevicePairingMock,
  removePairedDeviceMock,
  rejectDevicePairingMock,
  revokeDeviceTokenMock,
  rotateDeviceTokenMock,
  updatePairedDeviceMetadataMock,
} = vi.hoisted(() => ({
  approveDevicePairingMock: vi.fn(),
  getPairedDeviceMock: vi.fn(),
  getPendingDevicePairingMock: vi.fn(),
  listDevicePairingMock: vi.fn(),
  removePairedDeviceMock: vi.fn(),
  rejectDevicePairingMock: vi.fn(),
  revokeDeviceTokenMock: vi.fn(),
  rotateDeviceTokenMock: vi.fn(),
  updatePairedDeviceMetadataMock: vi.fn(),
}));

export {
  approveDevicePairingMock,
  getPairedDeviceMock,
  getPendingDevicePairingMock,
  listDevicePairingMock,
  removePairedDeviceMock,
  rejectDevicePairingMock,
  revokeDeviceTokenMock,
  rotateDeviceTokenMock,
  updatePairedDeviceMetadataMock,
};

vi.mock("../../infra/device-pairing.js", async () => {
  const actual = await vi.importActual<typeof import("../../infra/device-pairing.js")>(
    "../../infra/device-pairing.js",
  );
  return {
    ...actual,
    getPairedDevice: getPairedDeviceMock,
    getPendingDevicePairing: getPendingDevicePairingMock,
    listDevicePairing: listDevicePairingMock,
    removePairedDevice: removePairedDeviceMock,
    rejectDevicePairing: rejectDevicePairingMock,
    updatePairedDeviceMetadata: updatePairedDeviceMetadataMock,
  };
});

vi.mock("../../infra/device-pairing-approval.js", async () => {
  const actual = await vi.importActual<typeof import("../../infra/device-pairing-approval.js")>(
    "../../infra/device-pairing-approval.js",
  );
  return { ...actual, approveDevicePairing: approveDevicePairingMock };
});

vi.mock("../../infra/device-pairing-tokens.js", async () => {
  const actual = await vi.importActual<typeof import("../../infra/device-pairing-tokens.js")>(
    "../../infra/device-pairing-tokens.js",
  );
  return {
    ...actual,
    revokeDeviceToken: revokeDeviceTokenMock,
    rotateDeviceToken: rotateDeviceTokenMock,
  };
});

export function createClient(
  scopes: string[],
  deviceId?: string,
  opts?: {
    isDeviceTokenAuth?: boolean;
  },
) {
  return {
    ...(opts?.isDeviceTokenAuth !== undefined ? { isDeviceTokenAuth: opts.isDeviceTokenAuth } : {}),
    connect: {
      scopes,
      ...(deviceId ? { device: { id: deviceId } } : {}),
    },
  } as never;
}

export function createOptions(
  method: string,
  params: Record<string, unknown>,
  overrides?: Partial<GatewayRequestHandlerOptions>,
): GatewayRequestHandlerOptions {
  return {
    req: { type: "req", id: "req-1", method, params },
    params,
    client: null,
    isWebchatConnect: () => false,
    respond: vi.fn(),
    context: {
      broadcast: vi.fn(),
      disconnectClientsForDevice: vi.fn(),
      invalidateClientsForDevice: vi.fn(),
      logGateway: {
        debug: vi.fn(),
        error: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
      },
      nodeRegistry: {
        updateSurface: vi.fn(),
      },
    },
    ...overrides,
  } as unknown as GatewayRequestHandlerOptions;
}

export function mockPairedOperatorDevice(): void {
  getPairedDeviceMock.mockResolvedValue({
    deviceId: "device-1",
    role: "operator",
    roles: ["operator"],
    scopes: ["operator.pairing"],
    tokens: {
      operator: {
        token: "old-token",
        role: "operator",
        scopes: ["operator.pairing"],
        createdAtMs: 123,
      },
    },
  });
}

export function mockRotateOperatorTokenSuccess(): void {
  rotateDeviceTokenMock.mockResolvedValue({
    ok: true,
    entry: {
      token: "new-token",
      role: "operator",
      scopes: ["operator.pairing"],
      createdAtMs: 456,
      rotatedAtMs: 789,
    },
  });
}

export function expectRespondedErrorMessage(
  opts: GatewayRequestHandlerOptions,
  message: string,
): void {
  const respond = opts.respond as ReturnType<typeof vi.fn>;
  expect(respond).toHaveBeenCalledTimes(1);
  const call = respond.mock.calls[0] as unknown as [boolean, unknown, { message?: string }];
  expect(call[0]).toBe(false);
  expect(call[1]).toBeUndefined();
  expect(call[2]?.message).toBe(message);
}

export function captureSecurityEvents(): {
  events: DiagnosticSecurityEvent[];
  stop: () => void;
} {
  const events: DiagnosticSecurityEvent[] = [];
  const stop = onInternalDiagnosticEvent((event, metadata) => {
    if (metadata.trusted && event.type === "security.event") {
      events.push(event);
    }
  });
  return { events, stop };
}

export async function seedNodeWakeState(nodeId: string): Promise<void> {
  await runNodeWakeAttempt({
    nodeId,
    force: true,
    throttleMs: 60_000,
    attempt: async (markAttempted) => {
      markAttempted();
      return { available: true, throttled: false, path: "sent", durationMs: 1 };
    },
  });
  await runNodeWakeNudgeAttempt({
    nodeId,
    throttleMs: 60_000,
    throttled: () => ({ sent: false, throttled: true, reason: "throttled", durationMs: 0 }),
    attempt: async () => ({ sent: true, throttled: false, reason: "sent", durationMs: 1 }),
  });
}

export function resetDeviceHandlerTestState(): void {
  resetDiagnosticEventsForTest();
  resetNodeWakeStateForTest();
  vi.clearAllMocks();
}
