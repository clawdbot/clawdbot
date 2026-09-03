import { vi } from "vitest";
import type { MatrixAuth } from "./types.js";

export function authFor(accountId: string): MatrixAuth {
  return {
    accountId,
    homeserver: "https://matrix.example.org",
    userId: `@${accountId}:example.org`,
    accessToken: `token-${accountId}`,
    password: "secret", // pragma: allowlist secret
    deviceId: `${accountId.toUpperCase()}-DEVICE`,
    deviceName: `${accountId} device`,
    initialSyncLimit: undefined,
    encryption: false,
  };
}

export function createMockClient(name: string, callOrder: string[] = []) {
  return {
    name,
    start: vi.fn(async (_params?: { abortSignal?: AbortSignal }) => {
      callOrder.push("start");
    }),
    quiesceSync: vi.fn(async () => {
      callOrder.push("quiesce");
    }),
    stop: vi.fn(() => {
      callOrder.push("stop");
    }),
    stopAndPersist: vi.fn(async () => {
      callOrder.push("persist");
    }),
    stopWithoutPersist: vi.fn(async () => {
      callOrder.push("discard");
    }),
    drainPendingDecryptions: vi.fn(async (reason: string) => {
      callOrder.push(
        reason === "matrix monitor sync quiesce"
          ? "drain-quiesce"
          : reason === "matrix shared client final shutdown"
            ? "drain-final"
            : "drain-poison",
      );
    }),
    getJoinedRooms: vi.fn(async () => [] as string[]),
    crypto: undefined,
  };
}
