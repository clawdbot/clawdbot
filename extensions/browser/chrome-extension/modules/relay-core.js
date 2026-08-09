// Pure helpers for the OpenClaw extension: pairing-string parsing, reconnect
// backoff, and Chrome tab-group color mapping. No chrome.* usage here so the
// repo's vitest suite can exercise the logic directly.

/** Tab group shown to the user; an ACL in selected mode and an ownership marker in all mode. */
export const OPENCLAW_TAB_GROUP_TITLE = "OpenClaw";
export const ACCESS_MODE_ALL = "all";
export const ACCESS_MODE_SELECTED = "selected";
const EXTENSION_RELAY_PROTOCOL = "openclaw-extension-relay.v2";
const RELAY_SECRET_PATTERN = /^[0-9a-f]{64}$/;
const PAIRING_STORAGE_KEYS = ["relayUrl", "gatewayUrl", "token", "authVersion"];
const ACCESS_MODE_KEY = "accessMode";
const PAIRING_STATUS_KEY = "pairingStatus";
const UNSUPPORTED_PROXY_PREFIX_STATUS = "proxy-prefix-unsupported";
const UNSUPPORTED_PROXY_PREFIX_HINT =
  "Stored proxy-prefixed browser relay pairing is no longer supported. Re-run `openclaw browser extension pair` with a Gateway URL that has no path prefix.";

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

function isLoopbackHost(hostname) {
  const normalized = hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.+$/, "");
  if (normalized === "localhost" || normalized === "::1") {
    return true;
  }
  const ipv4 = /^(\d{1,3})(?:\.\d{1,3}){3}$/.exec(normalized);
  if (ipv4?.[1] === "127") {
    return true;
  }
  // URL canonicalizes mapped loopback addresses to ::ffff:7fxx:xxxx.
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(normalized);
  return mapped ? Number.parseInt(mapped[1], 16) >> 8 === 0x7f : false;
}

function isAllowedWebSocketUrl(url) {
  if (url.username || url.password) {
    return false;
  }
  return url.protocol === "wss:" || (url.protocol === "ws:" && isLoopbackHost(url.hostname));
}

function parseGatewayHint(raw) {
  if (typeof raw !== "string") {
    return null;
  }
  const value = raw.trim();
  if (!value) {
    return null;
  }
  let gateway;
  try {
    gateway = new URL(value);
  } catch {
    return null;
  }
  if (!isAllowedWebSocketUrl(gateway) || gateway.search || gateway.hash) {
    return null;
  }
  return value;
}

function directGatewayUrlFromRelay(relay) {
  if (relay.pathname !== "/browser/extension") {
    return null;
  }
  const gateway = new URL(relay.toString());
  gateway.pathname = "/";
  gateway.search = "";
  return gateway.toString();
}

function isUnsupportedProxyPrefix(raw) {
  if (typeof raw !== "string") {
    return false;
  }
  try {
    const relay = new URL(raw);
    return (
      isAllowedWebSocketUrl(relay) &&
      relay.pathname !== "/browser/extension" &&
      relay.pathname.endsWith("/browser/extension")
    );
  } catch {
    return false;
  }
}

function normalizeRelayQuery(relay) {
  const query = [...relay.searchParams];
  if (
    query.some(([key, value]) => key !== "profile" || !/^[a-z0-9-]+$/.test(value)) ||
    query.filter(([key]) => key === "profile").length > 1
  ) {
    return false;
  }
  relay.searchParams.sort();
  return true;
}

function validatePairingFields(relayUrl, token, gatewayUrl) {
  if (typeof relayUrl !== "string" || typeof token !== "string") {
    return null;
  }
  if (!RELAY_SECRET_PATTERN.test(token)) {
    return null;
  }
  let relay;
  try {
    relay = new URL(relayUrl);
  } catch {
    return null;
  }
  const supportedPath =
    (isLoopbackHost(relay.hostname) && relay.pathname === "/extension") ||
    relay.pathname === "/browser/extension";
  if (
    !isAllowedWebSocketUrl(relay) ||
    !supportedPath ||
    !normalizeRelayQuery(relay) ||
    relay.hash
  ) {
    return null;
  }
  const hasGateway = gatewayUrl !== undefined && gatewayUrl !== "";
  const parsedGateway = hasGateway ? parseGatewayHint(gatewayUrl) : undefined;
  if (hasGateway && !parsedGateway) {
    return null;
  }
  const directGateway = directGatewayUrlFromRelay(relay);
  if (directGateway && parsedGateway) {
    const normalizedGateway = new URL(parsedGateway);
    normalizedGateway.pathname = normalizedGateway.pathname.replace(/\/+$/, "") || "/";
    if (normalizedGateway.toString() !== directGateway) {
      return null;
    }
  }
  return {
    relayUrl: relay.toString(),
    token,
    ...(parsedGateway ? { gatewayUrl: parsedGateway } : {}),
  };
}

/**
 * Parse a pairing string printed by `openclaw browser extension pair`.
 * Shape: ws://127.0.0.1:<port>/extension?gateway=<url>#<token>
 * The additive gateway hint is not a credential; old extensions safely pass
 * it through to the relay while new extensions remove it before connecting.
 */
export function parsePairingString(raw) {
  const trimmed = String(raw ?? "").trim();
  const hashIndex = trimmed.indexOf("#");
  if (hashIndex <= 0) {
    return null;
  }
  const relayUrl = trimmed.slice(0, hashIndex);
  const token = trimmed.slice(hashIndex + 1);
  let parsed;
  try {
    parsed = new URL(relayUrl);
  } catch {
    return null;
  }
  const query = [...parsed.searchParams];
  const gatewayEntries = query.filter(([key]) => key === "gateway");
  const profileEntries = query.filter(([key]) => key === "profile");
  if (
    gatewayEntries.length > 1 ||
    profileEntries.length > 1 ||
    query.some(([key]) => key !== "gateway" && key !== "profile")
  ) {
    return null;
  }
  const gatewayUrl = gatewayEntries[0]?.[1];
  if ((gatewayEntries.length === 1 && !gatewayUrl?.trim()) || profileEntries[0]?.[1] === "") {
    return null;
  }
  parsed.searchParams.delete("gateway");
  parsed.searchParams.sort();
  return validatePairingFields(parsed.toString(), token, gatewayUrl);
}

/** Validate the canonical tuple persisted in chrome.storage.local. */
function parseStoredPairing(stored) {
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) {
    return null;
  }
  const parsed = validatePairingFields(stored.relayUrl, stored.token, stored.gatewayUrl);
  if (
    !parsed ||
    (stored.authVersion !== undefined && stored.authVersion !== 2) ||
    parsed.relayUrl !== stored.relayUrl ||
    parsed.token !== stored.token ||
    (parsed.gatewayUrl ?? "") !== (stored.gatewayUrl ?? "")
  ) {
    return null;
  }
  return parsed;
}

/** Own serialized validation and mutation at the extension pairing storage boundary. */
export function createPairingConfigStore(storage) {
  let chain = Promise.resolve();
  let invalidObserved = false;
  let invalidationRevision = 0;
  const run = (task) => {
    const pending = chain.then(task, task);
    chain = pending.catch(() => undefined);
    return pending;
  };
  return {
    get invalidationRevision() {
      return invalidationRevision;
    },
    read: () =>
      run(async () => {
        const stored = await storage.get([
          ...PAIRING_STORAGE_KEYS,
          ACCESS_MODE_KEY,
          PAIRING_STATUS_KEY,
          "groupColor",
        ]);
        const hasPairing = PAIRING_STORAGE_KEYS.some((key) => Object.hasOwn(stored, key));
        const pairing = hasPairing ? parseStoredPairing(stored) : null;
        let pairingStatus =
          stored[PAIRING_STATUS_KEY] === UNSUPPORTED_PROXY_PREFIX_STATUS
            ? UNSUPPORTED_PROXY_PREFIX_STATUS
            : "";
        if (hasPairing && !pairing) {
          if (!invalidObserved) {
            invalidationRevision += 1;
          }
          invalidObserved = true;
          pairingStatus = isUnsupportedProxyPrefix(stored.relayUrl)
            ? UNSUPPORTED_PROXY_PREFIX_STATUS
            : "";
          await storage.remove(PAIRING_STORAGE_KEYS).catch(() => undefined);
          if (pairingStatus) {
            await storage.set({ [PAIRING_STATUS_KEY]: pairingStatus }).catch(() => undefined);
          } else if (Object.hasOwn(stored, PAIRING_STATUS_KEY)) {
            await storage.remove([PAIRING_STATUS_KEY]).catch(() => undefined);
          }
        } else {
          invalidObserved = false;
          if (pairing) {
            const repairs = {};
            if (stored.authVersion === undefined) {
              repairs.authVersion = 2;
            }
            // Pairings created before access modes promised group-only access.
            // Unknown future/corrupt values fail closed without discarding the key.
            if (
              stored[ACCESS_MODE_KEY] !== ACCESS_MODE_ALL &&
              stored[ACCESS_MODE_KEY] !== ACCESS_MODE_SELECTED
            ) {
              repairs[ACCESS_MODE_KEY] = ACCESS_MODE_SELECTED;
            }
            if (Object.keys(repairs).length > 0) {
              await storage.set(repairs);
            }
          }
          if (pairing && pairingStatus) {
            pairingStatus = "";
            await storage.remove([PAIRING_STATUS_KEY]).catch(() => undefined);
          }
        }
        return {
          relayUrl: pairing?.relayUrl ?? "",
          token: pairing?.token ?? "",
          gatewayUrl: pairing?.gatewayUrl ?? "",
          authVersion: pairing ? 2 : undefined,
          accessMode: pairing
            ? stored[ACCESS_MODE_KEY] === ACCESS_MODE_ALL
              ? ACCESS_MODE_ALL
              : ACCESS_MODE_SELECTED
            : ACCESS_MODE_SELECTED,
          groupColor: typeof stored.groupColor === "string" ? stored.groupColor : "orange",
          pairingStatusHint:
            pairingStatus === UNSUPPORTED_PROXY_PREFIX_STATUS ? UNSUPPORTED_PROXY_PREFIX_HINT : "",
        };
      }),
    save: (pairing, groupColor, accessMode = ACCESS_MODE_ALL) =>
      run(async () => {
        await storage.set({
          relayUrl: pairing.relayUrl,
          token: pairing.token,
          gatewayUrl: pairing.gatewayUrl ?? "",
          authVersion: 2,
          accessMode: accessMode === ACCESS_MODE_SELECTED ? ACCESS_MODE_SELECTED : ACCESS_MODE_ALL,
          groupColor,
        });
        await storage.remove([PAIRING_STATUS_KEY]);
      }),
    setAccessMode: (accessMode) =>
      run(async () => {
        const stored = await storage.get(PAIRING_STORAGE_KEYS);
        if (!parseStoredPairing(stored)) {
          throw new Error("Pair the extension first.");
        }
        const normalized = accessMode === ACCESS_MODE_ALL ? ACCESS_MODE_ALL : ACCESS_MODE_SELECTED;
        await storage.set({ [ACCESS_MODE_KEY]: normalized });
        return normalized;
      }),
    clear: () =>
      run(() => storage.remove([...PAIRING_STORAGE_KEYS, ACCESS_MODE_KEY, PAIRING_STATUS_KEY])),
  };
}

/** Build the v2 WebSocket subprotocol list; credentials stay in WebCrypto only. */
export function buildRelayWsProtocols() {
  return [EXTENSION_RELAY_PROTOCOL];
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
