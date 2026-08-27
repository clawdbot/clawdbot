/** Projects an MMDB city record into the coarse shape callers display. */
import type { GeolocationCityRecord } from "./database-store.js";

type GeolocationResult = {
  city?: string;
  region?: string;
  country?: string;
  countryCode?: string;
};

// The record type marks `en` required, but Lite builds do ship entries without
// it, so this reads defensively rather than trusting the declaration.
function englishName(names: { readonly en?: string } | undefined): string | undefined {
  const value = names?.en?.trim();
  return value ? value : undefined;
}

/**
 * Returns undefined when the database has no usable placement for the address,
 * so callers can distinguish "not found" from an empty-but-present answer.
 */
export function projectGeolocationRecord(
  record: GeolocationCityRecord | null,
): GeolocationResult | undefined {
  if (!record) {
    return undefined;
  }
  const result: GeolocationResult = {
    ...(englishName(record.city?.names) ? { city: englishName(record.city?.names) } : {}),
    ...(englishName(record.subdivisions?.[0]?.names)
      ? { region: englishName(record.subdivisions?.[0]?.names) }
      : {}),
    ...(englishName(record.country?.names) ? { country: englishName(record.country?.names) } : {}),
    ...(record.country?.iso_code ? { countryCode: record.country.iso_code } : {}),
  };
  return Object.keys(result).length > 0 ? result : undefined;
}
