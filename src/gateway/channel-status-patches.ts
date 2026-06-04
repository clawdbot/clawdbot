// Channel status patch factories centralize timestamp fields that multiple
// runtime paths send into the gateway status store.
/** Patch emitted when a channel connection is established. */
export type ConnectedChannelStatusPatch = {
  connected: true;
  lastConnectedAt: number;
  lastEventAt: number;
};

/** Patch emitted when a channel transport reports activity without reconnecting. */
export type TransportActivityChannelStatusPatch = {
  lastTransportActivityAt: number;
};

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
