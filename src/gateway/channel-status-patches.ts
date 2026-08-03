// Channel status patch factories centralize timestamp fields that multiple
// runtime paths send into the gateway status store.
import type { ChannelAccountSnapshot } from "../channels/plugins/types.core.js";

/** Patch emitted when a channel connection is established. */
type ConnectedChannelStatusPatch = {
  connected: true;
  lastConnectedAt: number;
  lastEventAt: number;
};

/** Patch emitted when a channel transport reports activity without reconnecting. */
type TransportActivityChannelStatusPatch = {
  lastTransportActivityAt: number;
};

type ReadyChannelStatusPatch = {
  running: true;
  connected: true;
  lifecycle: "ready";
  lastConnectedAt: number;
  lastError: null;
  terminalDisconnect: undefined;
};

type BlockedChannelStatusPatch = {
  lifecycle: "blocked";
  terminalDisconnect: true;
  lastError: string;
};

type StoppedChannelStatusPatch = {
  running: false;
  connected: false;
  lifecycle: "stopped";
};

type ReadyChannelStatusExtras = Partial<
  Omit<ChannelAccountSnapshot, keyof ReadyChannelStatusPatch>
> & {
  lastConnectedAt?: number;
};
type BlockedChannelStatusExtras = Partial<
  Omit<ChannelAccountSnapshot, keyof BlockedChannelStatusPatch>
>;
type StoppedChannelStatusExtras = Partial<
  Omit<ChannelAccountSnapshot, keyof StoppedChannelStatusPatch>
>;

/** Creates a connected-channel status patch with matching connection/event timestamps. */
export function createConnectedChannelStatusPatch(
  at: number = Date.now(),
): ConnectedChannelStatusPatch {
  return {
    connected: true,
    lastConnectedAt: at,
    lastEventAt: at,
  };
}

/** Creates a transport-activity patch for health/activity monitors. */
export function createTransportActivityStatusPatch(
  at: number = Date.now(),
): TransportActivityChannelStatusPatch {
  return {
    lastTransportActivityAt: at,
  };
}

/** Creates a ready patch that clears any retained terminal-auth verdict. */
export function channelReadyPatch<TExtras extends ReadyChannelStatusExtras = Record<never, never>>(
  extras?: TExtras,
): ReadyChannelStatusPatch & TExtras {
  return {
    running: true,
    connected: true,
    lifecycle: "ready",
    lastConnectedAt: Date.now(),
    lastError: null,
    terminalDisconnect: undefined,
    ...extras,
  };
}

/** Creates a terminal blocked patch with a required operator-facing error. */
export function channelBlockedPatch<
  TExtras extends BlockedChannelStatusExtras = Record<never, never>,
>(lastError: string, extras?: TExtras): BlockedChannelStatusPatch & TExtras {
  return {
    lifecycle: "blocked",
    terminalDisconnect: true,
    lastError,
    ...extras,
  };
}

/** Creates the shared patch emitted after a channel account has stopped. */
export function channelStoppedPatch<
  TExtras extends StoppedChannelStatusExtras = Record<never, never>,
>(extras?: TExtras): StoppedChannelStatusPatch & TExtras {
  return {
    running: false,
    connected: false,
    lifecycle: "stopped",
    ...extras,
  };
}
