// Gateway broadcast types are shared by websocket fanout helpers and request
// contexts so event delivery can carry optional state-version hints.
type GatewayBroadcastStateVersion = {
  presence?: number;
  health?: number;
};

/** Options for gateway websocket broadcasts. */
export type GatewayBroadcastOpts = {
  dropIfSlow?: boolean;
  stateVersion?: GatewayBroadcastStateVersion;
};

/** Broadcast function signature for all connected clients. */
export type GatewayBroadcastFn = (
  event: string,
  payload: unknown,
  opts?: GatewayBroadcastOpts,
) => void;

/** Broadcast function signature for targeted connection ids. */
export type GatewayBroadcastToConnIdsFn = (
  event: string,
  payload: unknown,
  connIds: ReadonlySet<string>,
  opts?: GatewayBroadcastOpts,
) => void;
