export type ConnectedChannelStatusPatch = {
  connected: true;
  lastConnectedAt: number;
  lastEventAt: number;
};

export type TransportActivityChannelStatusPatch = {
  lastTransportActivityAt: number;
};

export function createConnectedChannelStatusPatch(
  at: number = Date.now(),
): ConnectedChannelStatusPatch {
  return {
    connected: true,
    lastConnectedAt: at,
    lastEventAt: at,
  };
}

export function createTransportActivityStatusPatch(
  at: number = Date.now(),
): TransportActivityChannelStatusPatch {
  return {
    lastTransportActivityAt: at,
  };
}
