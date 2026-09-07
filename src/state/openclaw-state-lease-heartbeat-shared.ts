import type { OpenClawStateLeaseIdentity } from "./openclaw-state-lease-store.js";

export const LEASE_HEARTBEAT_START_TIMEOUT_MS = 5_000;

export const leaseHeartbeatState = {
  status: 0,
  request: 1,
  ack: 2,
  starting: 0n,
  ready: 1n,
  closed: 2n,
  lost: 3n,
} as const;

export type LeaseHeartbeatWorkerData = {
  path: string;
  identity: OpenClawStateLeaseIdentity;
  leaseMs: number;
  expiresAt: number;
  heartbeatMs: number;
  shared: SharedArrayBuffer;
};
