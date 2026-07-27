/** Normalized source kind for channel-provided geographic locations. */
export type LocationSource = "pin" | "place" | "live";

/** Channel-neutral location payload passed from plugins into shared prompt rendering. */
export type NormalizedLocation = {
  latitude: number;
  longitude: number;
  accuracy?: number;
  name?: string;
  address?: string;
  isLive?: boolean;
  source?: LocationSource;
  caption?: string;
};

/** Portable outbound location fields supported by channel send adapters. */
export type OutboundLocation = Pick<
  NormalizedLocation,
  "latitude" | "longitude" | "accuracy" | "name" | "address"
>;

function readOptionalLocationText(value: unknown, label: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value.trim();
}

/** Normalize a portable location payload at an outbound/plugin boundary. */
export function normalizeOutboundLocation(
  value: unknown,
  label = "location",
): OutboundLocation | undefined {
  if (value == null) {
    return undefined;
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  const raw = value as Record<string, unknown>;
  const latitude = raw.latitude;
  const longitude = raw.longitude;
  if (
    typeof latitude !== "number" ||
    !Number.isFinite(latitude) ||
    latitude < -90 ||
    latitude > 90
  ) {
    throw new Error(`${label}.latitude must be a finite number between -90 and 90.`);
  }
  if (
    typeof longitude !== "number" ||
    !Number.isFinite(longitude) ||
    longitude < -180 ||
    longitude > 180
  ) {
    throw new Error(`${label}.longitude must be a finite number between -180 and 180.`);
  }
  const accuracy = raw.accuracy;
  if (
    accuracy !== undefined &&
    (typeof accuracy !== "number" || !Number.isFinite(accuracy) || accuracy < 0 || accuracy > 1500)
  ) {
    throw new Error(`${label}.accuracy must be a finite number between 0 and 1500.`);
  }
  for (const unsupportedField of ["source", "isLive", "caption"] as const) {
    if (raw[unsupportedField] !== undefined) {
      throw new Error(`${label}.${unsupportedField} is not supported for outbound locations.`);
    }
  }
  const name = readOptionalLocationText(raw.name, `${label}.name`);
  const address = readOptionalLocationText(raw.address, `${label}.address`);
  return {
    latitude,
    longitude,
    ...(accuracy !== undefined ? { accuracy } : {}),
    ...(name ? { name } : {}),
    ...(address ? { address } : {}),
  };
}

/** Location payload after default source and live-state inference. */
type ResolvedLocation = NormalizedLocation & {
  source: LocationSource;
  isLive: boolean;
};

function resolveLocation(location: NormalizedLocation): ResolvedLocation {
  // Infer once so text formatting and structured context agree on pin/place/live semantics.
  const source =
    location.source ??
    (location.isLive ? "live" : location.name || location.address ? "place" : "pin");
  const isLive = location.isLive ?? source === "live";
  return { ...location, source, isLive };
}

function formatAccuracy(accuracy?: number): string {
  if (!Number.isFinite(accuracy)) {
    return "";
  }
  return ` ±${Math.round(accuracy ?? 0)}m`;
}

function formatCoords(latitude: number, longitude: number): string {
  return `${latitude.toFixed(6)}, ${longitude.toFixed(6)}`;
}

/**
 * Formats the safe inline location body shown to the model.
 *
 * Channel-provided labels, addresses, and captions are intentionally excluded
 * here; `toLocationContext` carries them into the untrusted metadata block.
 */
export function formatLocationText(location: NormalizedLocation): string {
  const resolved = resolveLocation(location);
  const coords = formatCoords(resolved.latitude, resolved.longitude);
  const accuracy = formatAccuracy(resolved.accuracy);

  if (resolved.source === "live" || resolved.isLive) {
    return `🛰 Live location: ${coords}${accuracy}`;
  }

  return `📍 ${coords}${accuracy}`;
}

/** Converts a normalized location into template context fields for prompt metadata. */
export function toLocationContext(location: NormalizedLocation): {
  LocationLat: number;
  LocationLon: number;
  LocationAccuracy?: number;
  LocationName?: string;
  LocationAddress?: string;
  LocationSource: LocationSource;
  LocationIsLive: boolean;
  LocationCaption?: string;
} {
  const resolved = resolveLocation(location);
  return {
    LocationLat: resolved.latitude,
    LocationLon: resolved.longitude,
    LocationAccuracy: resolved.accuracy,
    LocationName: resolved.name,
    LocationAddress: resolved.address,
    LocationSource: resolved.source,
    LocationIsLive: resolved.isLive,
    LocationCaption: resolved.caption,
  };
}
