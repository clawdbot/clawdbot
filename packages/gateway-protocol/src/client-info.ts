/**
 * Shared gateway client identity contract.
 *
 * These values cross the WebSocket handshake boundary, so additions must stay
 * aligned with protocol schemas and server policy checks.
 */
function normalizeOptionalLowercaseString(raw?: string | null): string | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }
  const normalized = raw.trim().toLowerCase();
  return normalized || undefined;
}

/** Canonical client ids accepted in gateway hello/connect payloads. */
export const GATEWAY_CLIENT_IDS = {
  WEBCHAT_UI: "webchat-ui",
  CONTROL_UI: "openclaw-control-ui",
  TUI: "openclaw-tui",
  WEBCHAT: "webchat",
  CLI: "cli",
  GATEWAY_CLIENT: "gateway-client",
  MACOS_APP: "openclaw-macos",
  IOS_APP: "openclaw-ios",
  ANDROID_APP: "openclaw-android",
  NODE_HOST: "node-host",
  TEST: "test",
  FINGERPRINT: "fingerprint",
  PROBE: "openclaw-probe",
} as const;

/** Stable gateway client ids used on the wire during hello/connect handshakes. */
export type GatewayClientId = (typeof GATEWAY_CLIENT_IDS)[keyof typeof GATEWAY_CLIENT_IDS];

// Back-compat naming (internal): these values are IDs, not display names.
export const GATEWAY_CLIENT_NAMES = GATEWAY_CLIENT_IDS;
/** Compatibility alias for internal callers that still use "name" terminology. */
export type GatewayClientName = GatewayClientId;

/** Coarse modes let policy group clients without matching every product id. */
export const GATEWAY_CLIENT_MODES = {
  WEBCHAT: "webchat",
  CLI: "cli",
  UI: "ui",
  BACKEND: "backend",
  NODE: "node",
  PROBE: "probe",
  TEST: "test",
} as const;

/** Coarse client category used for gateway policy and diagnostics. */
export type GatewayClientMode = (typeof GATEWAY_CLIENT_MODES)[keyof typeof GATEWAY_CLIENT_MODES];

/** Client metadata sent during gateway connection setup. */
export type GatewayClientInfo = {
  /** Stable product/client identifier from `GATEWAY_CLIENT_IDS`. */
  id: GatewayClientId;
  /** Human-readable label for diagnostics; not used for policy decisions. */
  displayName?: string;
  /** Client app or package version reported by the connecting process. */
  version: string;
  /** Runtime platform string, such as `darwin`, `ios`, `android`, or `web`. */
  platform: string;
  /** Optional device family used by native clients for display and routing hints. */
  deviceFamily?: string;
  /** Native hardware/model identifier when available. */
  modelIdentifier?: string;
  /** Coarse category from `GATEWAY_CLIENT_MODES` for policy and diagnostics. */
  mode: GatewayClientMode;
  /** Per-installation or per-process id used to distinguish same-product clients. */
  instanceId?: string;
};

/** Capability flags a client may advertise during the gateway handshake. */
export const GATEWAY_CLIENT_CAPS = {
  TOOL_EVENTS: "tool-events",
} as const;

/** Optional capability advertised by clients during gateway handshake. */
export type GatewayClientCap = (typeof GATEWAY_CLIENT_CAPS)[keyof typeof GATEWAY_CLIENT_CAPS];

const GATEWAY_CLIENT_ID_SET = new Set<GatewayClientId>(Object.values(GATEWAY_CLIENT_IDS));
const GATEWAY_CLIENT_MODE_SET = new Set<GatewayClientMode>(Object.values(GATEWAY_CLIENT_MODES));

/** Normalizes untrusted client ids and rejects unknown values. */
export function normalizeGatewayClientId(raw?: string | null): GatewayClientId | undefined {
  // Handshake input is intentionally case-insensitive, but policy decisions use
  // the canonical lowercase ids from the closed registry above.
  const normalized = normalizeOptionalLowercaseString(raw);
  if (!normalized) {
    return undefined;
  }
  return GATEWAY_CLIENT_ID_SET.has(normalized as GatewayClientId)
    ? (normalized as GatewayClientId)
    : undefined;
}

/** Normalizes legacy client-name fields through the canonical client-id registry. */
export function normalizeGatewayClientName(raw?: string | null): GatewayClientName | undefined {
  return normalizeGatewayClientId(raw);
}

/** Normalizes untrusted client modes and rejects unknown values. */
export function normalizeGatewayClientMode(raw?: string | null): GatewayClientMode | undefined {
  const normalized = normalizeOptionalLowercaseString(raw);
  if (!normalized) {
    return undefined;
  }
  return GATEWAY_CLIENT_MODE_SET.has(normalized as GatewayClientMode)
    ? (normalized as GatewayClientMode)
    : undefined;
}

/** Checks a client-advertised capability list without treating missing caps as errors. */
export function hasGatewayClientCap(
  caps: string[] | null | undefined,
  cap: GatewayClientCap,
): boolean {
  if (!Array.isArray(caps)) {
    return false;
  }
  return caps.includes(cap);
}
