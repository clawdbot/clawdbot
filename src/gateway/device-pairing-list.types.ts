import type { Static } from "typebox";
import type { DevicePairRequestedEventSchema } from "../../packages/gateway-protocol/src/schema/devices.js";
import type { DeviceAuthTokenSummary } from "../infra/device-pairing-tokens.js";
import type { PairedDeviceApprovalKind } from "../infra/device-pairing.types.js";

type DevicePairRequestedEvent = Static<typeof DevicePairRequestedEventSchema>;

export type DeviceTokenSummary = Pick<DeviceAuthTokenSummary, "role"> &
  Partial<Omit<DeviceAuthTokenSummary, "role">>;

export type PendingDevice = Pick<DevicePairRequestedEvent, "requestId" | "deviceId"> &
  Partial<Omit<DevicePairRequestedEvent, "requestId" | "deviceId">>;

/** Redacted list metadata, independent of the persisted pairing record and bearer tokens. */
export type PairedDevice = Omit<PendingDevice, "requestId" | "silent" | "isRepair" | "ts"> & {
  /** Operator-assigned label; preferred over client displayName when rendering. */
  operatorLabel?: string;
  tokens?: DeviceTokenSummary[];
  approvedVia?: PairedDeviceApprovalKind;
  /** Server-computed: the device currently holds a live gateway connection. */
  connected?: boolean;
  createdAtMs?: number;
  approvedAtMs?: number;
  lastSeenAtMs?: number;
  // Clients need only these node-approval hints, not the persisted capability surface.
  nodeSurface?: { displayName?: string };
  pendingNodeSurface?: { requestId: string; displayName?: string; remoteIp?: string };
};

export type DevicePairingList = {
  pending: PendingDevice[];
  paired: PairedDevice[];
};
