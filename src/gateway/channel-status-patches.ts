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
export function channelReadyPatch(): ReadyChannelStatusPatch;
export function channelReadyPatch<TExtras extends ReadyChannelStatusExtras>(
  extras: TExtras,
): ReadyChannelStatusPatch & TExtras;
export function channelReadyPatch(
  extras: ReadyChannelStatusExtras = {},
): ReadyChannelStatusPatch & ReadyChannelStatusExtras {
  return Object.assign(
    {
      running: true as const,
      connected: true as const,
      lifecycle: "ready" as const,
      lastConnectedAt: Date.now(),
      lastError: null,
      terminalDisconnect: undefined,
    },
    extras,
  );
}

/** Creates a terminal blocked patch with a required operator-facing error. */
export function channelBlockedPatch(lastError: string): BlockedChannelStatusPatch;
export function channelBlockedPatch<TExtras extends BlockedChannelStatusExtras>(
  lastError: string,
  extras: TExtras,
): BlockedChannelStatusPatch & TExtras;
export function channelBlockedPatch(
  lastError: string,
  extras: BlockedChannelStatusExtras = {},
): BlockedChannelStatusPatch & BlockedChannelStatusExtras {
  return Object.assign(
    {
      lifecycle: "blocked" as const,
      terminalDisconnect: true as const,
      lastError,
    },
    extras,
  );
}

/** Creates the shared patch emitted after a channel account has stopped. */
export function channelStoppedPatch(): StoppedChannelStatusPatch;
export function channelStoppedPatch<TExtras extends StoppedChannelStatusExtras>(
  extras: TExtras,
): StoppedChannelStatusPatch & TExtras;
export function channelStoppedPatch(
  extras: StoppedChannelStatusExtras = {},
): StoppedChannelStatusPatch & StoppedChannelStatusExtras {
  return Object.assign(
    {
      running: false as const,
      connected: false as const,
      lifecycle: "stopped" as const,
    },
    extras,
  );
}
