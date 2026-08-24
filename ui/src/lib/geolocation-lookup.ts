import { asOptionalRecord, readStringField } from "@openclaw/normalization-core/record-coerce";
import { readAvatarGatewayContext, registerAvatarGatewayReset } from "./identity-avatar.ts";

/** Coarse placement for one address, plus the credit its data license requires. */
export type ClientGeolocation = {
  city?: string;
  region?: string;
  country?: string;
  attribution?: { text: string; url: string };
};

/**
 * Lookups have three outcomes and callers must tell them apart: a database that
 * cannot answer yet is retryable, while an address the database does not place
 * is final. Collapsing them caches a permanent blank for a Gateway that was
 * merely still downloading.
 */
type ClientGeolocationResult =
  | { status: "located"; location: ClientGeolocation }
  | { status: "absent" }
  | { status: "unavailable" };

const LOOKUP_TIMEOUT_MS = 15_000;
// Presence rosters are small; the cap only stops an unbounded map on a busy
// gateway where entries churn.
const LOOKUP_CACHE_MAX_ENTRIES = 256;

const lookupCache = new Map<string, Promise<ClientGeolocationResult>>();

function clearClientGeolocationCache(): void {
  lookupCache.clear();
}

// Endpoint and credentials both come from the shared Gateway context, so a
// switch must drop cached placements instead of showing the previous Gateway's
// answer for the same address.
registerAvatarGatewayReset(clearClientGeolocationCache);

function readLocation(payload: unknown): ClientGeolocationResult {
  const record = asOptionalRecord(payload);
  if (record?.found !== true) {
    return { status: "absent" };
  }
  const text = (value: string | undefined) => (value?.trim() ? value : undefined);
  const attribution = asOptionalRecord(record.attribution);
  const attributionText = text(readStringField(attribution, "text"));
  const attributionUrl = text(readStringField(attribution, "url"));
  const city = text(readStringField(record, "city"));
  const region = text(readStringField(record, "region"));
  const country = text(readStringField(record, "country"));
  const location: ClientGeolocation = {
    ...(city ? { city } : {}),
    ...(region ? { region } : {}),
    ...(country ? { country } : {}),
    ...(attributionText && attributionUrl
      ? { attribution: { text: attributionText, url: attributionUrl } }
      : {}),
  };
  return Object.keys(location).length > 0 ? { status: "located", location } : { status: "absent" };
}

async function requestGeolocation(ip: string): Promise<ClientGeolocationResult> {
  const { origin, authHeader } = readAvatarGatewayContext();
  try {
    const response = await fetch(
      `${origin ?? ""}/plugins/geolocation/lookup?ip=${encodeURIComponent(ip)}`,
      {
        credentials: "include",
        ...(authHeader ? { headers: { Authorization: authHeader } } : {}),
        signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
      },
    );
    // Only a 200 is a real answer. 503 means the database is still downloading
    // or missing, which the caller may retry.
    return response.ok ? readLocation(await response.json()) : { status: "unavailable" };
  } catch {
    return { status: "unavailable" };
  }
}

/**
 * Resolves one address through the geolocation plugin. Definitive answers are
 * cached; unavailable ones are not, so a later attempt can still succeed once
 * the database is ready.
 */
export function lookupClientGeolocation(ip: string): Promise<ClientGeolocationResult> {
  const cached = lookupCache.get(ip);
  if (cached) {
    return cached;
  }
  const pending = requestGeolocation(ip).then((result) => {
    if (result.status === "unavailable") {
      lookupCache.delete(ip);
    }
    return result;
  });
  if (lookupCache.size >= LOOKUP_CACHE_MAX_ENTRIES) {
    const oldest = lookupCache.keys().next();
    if (!oldest.done) {
      lookupCache.delete(oldest.value);
    }
  }
  lookupCache.set(ip, pending);
  return pending;
}
