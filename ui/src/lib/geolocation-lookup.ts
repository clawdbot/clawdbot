import { asOptionalRecord, readStringField } from "@openclaw/normalization-core/record-coerce";
import { readAvatarGatewayContext } from "./identity-avatar.ts";

/** Coarse placement for one address, plus the credit its data license requires. */
export type ClientGeolocation = {
  city?: string;
  region?: string;
  country?: string;
  attribution?: { text: string; url: string };
};

const LOOKUP_TIMEOUT_MS = 15_000;
// Presence rosters are small; the cap only stops an unbounded map on a busy
// gateway where entries churn.
const LOOKUP_CACHE_MAX_ENTRIES = 256;

const lookupCache = new Map<string, Promise<ClientGeolocation | null>>();

function readLocation(payload: unknown): ClientGeolocation | null {
  const record = asOptionalRecord(payload);
  if (record?.found !== true) {
    return null;
  }
  const text = (value: string | undefined) => (value?.trim() ? value : undefined);
  const attribution = asOptionalRecord(record.attribution);
  const attributionText = text(readStringField(attribution, "text"));
  const attributionUrl = text(readStringField(attribution, "url"));
  const city = text(readStringField(record, "city"));
  const region = text(readStringField(record, "region"));
  const country = text(readStringField(record, "country"));
  return {
    ...(city ? { city } : {}),
    ...(region ? { region } : {}),
    ...(country ? { country } : {}),
    ...(attributionText && attributionUrl
      ? { attribution: { text: attributionText, url: attributionUrl } }
      : {}),
  };
}

/**
 * Resolves one address through the geolocation plugin. Returns null for any
 * unavailable answer — a missing plugin, a database still downloading, or an
 * address the database cannot place all render the same way: no location shown.
 */
export function lookupClientGeolocation(ip: string): Promise<ClientGeolocation | null> {
  const cached = lookupCache.get(ip);
  if (cached) {
    return cached;
  }
  const { origin, authHeader } = readAvatarGatewayContext();
  const base = origin ?? "";
  const pending = (async () => {
    try {
      const response = await fetch(
        `${base}/plugins/geolocation/lookup?ip=${encodeURIComponent(ip)}`,
        {
          credentials: "include",
          ...(authHeader ? { headers: { Authorization: authHeader } } : {}),
          signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
        },
      );
      if (!response.ok) {
        return null;
      }
      return readLocation(await response.json());
    } catch {
      return null;
    }
  })();
  if (lookupCache.size >= LOOKUP_CACHE_MAX_ENTRIES) {
    const oldest = lookupCache.keys().next();
    if (!oldest.done) {
      lookupCache.delete(oldest.value);
    }
  }
  lookupCache.set(ip, pending);
  return pending;
}
