/** Current gateway protocol version emitted by modern clients and servers. */
export const PROTOCOL_VERSION = 4 as const;
/** Lowest general client protocol version accepted by the gateway. */
export const MIN_CLIENT_PROTOCOL_VERSION = 4 as const;
/** Lowest authenticated node protocol version accepted by the gateway. */
export const MIN_NODE_PROTOCOL_VERSION = 3 as const;
/** Lowest lightweight probe protocol version accepted by the gateway. */
export const MIN_PROBE_PROTOCOL_VERSION = 3 as const;
