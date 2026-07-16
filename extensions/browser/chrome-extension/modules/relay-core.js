// Pure helpers for the OpenClaw extension: pairing-string parsing, reconnect
// backoff, and Chrome tab-group color mapping. No chrome.* usage here so the
// repo's vitest suite can exercise the logic directly.

/** Tab group shown to the user; membership == what the agent may touch. */
export const OPENCLAW_TAB_GROUP_TITLE = "OpenClaw";
const EXTENSION_RELAY_PROTOCOL = "openclaw-extension-relay";
const EXTENSION_RELAY_TOKEN_PROTOCOL_PREFIX = "openclaw-extension-token.";

const CHROME_GROUP_COLORS = {
  grey: [128, 128, 128],
  blue: [66, 133, 244],
  red: [219, 68, 55],
  yellow: [244, 180, 0],
  green: [15, 157, 88],
  pink: [233, 30, 99],
  purple: [156, 39, 176],
  cyan: [0, 188, 212],
  orange: [255, 112, 32],
};

/**
 * Parse a pairing string printed by `openclaw browser extension pair`.
 * Shape: ws://127.0.0.1:<port>/extension#<token>
 * Returns { relayUrl, token } or null when malformed.
 */
export function parsePairingString(raw) {
  const trimmed = String(raw ?? "").trim();
  const hashIndex = trimmed.indexOf("#");
  if (hashIndex <= 0) {
    return null;
  }
  const relayUrl = trimmed.slice(0, hashIndex);
  const token = trimmed.slice(hashIndex + 1).trim();
  if (!token) {
    return null;
  }
  let parsed;
  try {
    parsed = new URL(relayUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
    return null;
  }
  if (!parsed.pathname.endsWith("/extension")) {
    return null;
  }
  return { relayUrl, token };
}

/** Build WebSocket subprotocols without putting the relay secret in the request URL. */
export function buildRelayWsProtocols(token) {
  return [EXTENSION_RELAY_PROTOCOL, `${EXTENSION_RELAY_TOKEN_PROTOCOL_PREFIX}${token}`];
}

/** Exponential reconnect backoff: 1s, 2s, 4s ... capped at 30s. */
export function reconnectDelayMs(attempt) {
  const capped = Math.min(Math.max(0, attempt), 5);
  return Math.min(1000 * 2 ** capped, 30_000);
}

/** Map a hex color to the closest Chrome tab-group color name. */
export function nearestGroupColor(hex) {
  const match = /^#?([0-9a-f]{6})$/i.exec(String(hex ?? "").trim());
  if (!match) {
    return "orange";
  }
  const value = Number.parseInt(match[1], 16);
  const r = (value >> 16) & 0xff;
  const g = (value >> 8) & 0xff;
  const b = value & 0xff;
  let best = "orange";
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const [name, [cr, cg, cb]] of Object.entries(CHROME_GROUP_COLORS)) {
    const distance = (r - cr) ** 2 + (g - cg) ** 2 + (b - cb) ** 2;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = name;
    }
  }
  return best;
}

/** Normalize a chrome.tabs.Tab into the relay's tab info shape. */
export function toRelayTabInfo(tab) {
  return {
    tabId: tab.id,
    url: tab.url ?? "",
    title: tab.title ?? "",
    active: tab.active === true,
  };
}
