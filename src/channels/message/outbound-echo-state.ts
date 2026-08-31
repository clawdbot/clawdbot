const OUTBOUND_MESSAGE_IDENTITIES_KEY = Symbol.for("openclaw.outboundMessageIdentities");

type OutboundMessageIdentityState = Map<string, number>;

function resolveState(): OutboundMessageIdentityState {
  const globalStore = globalThis as Record<PropertyKey, unknown>;
  const existing = globalStore[OUTBOUND_MESSAGE_IDENTITIES_KEY];
  if (existing instanceof Map) {
    return existing as OutboundMessageIdentityState;
  }
  const created: OutboundMessageIdentityState = new Map();
  globalStore[OUTBOUND_MESSAGE_IDENTITIES_KEY] = created;
  return created;
}

// Symbol-backed state survives duplicate module instances during plugin loading.
export const outboundMessageIdentities = resolveState();
