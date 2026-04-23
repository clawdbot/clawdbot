export type LocationSource = "pin" | "place" | "live";

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

type ResolvedLocation = NormalizedLocation & {
  source: LocationSource;
  isLive: boolean;
};

function resolveLocation(location: NormalizedLocation): ResolvedLocation {
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

export function formatLocationText(location: NormalizedLocation): string {
  const resolved = resolveLocation(location);
  const coords = formatCoords(resolved.latitude, resolved.longitude);
  const accuracy = formatAccuracy(resolved.accuracy);

  if (resolved.source === "live" || resolved.isLive) {
    return `🛰 Live location: ${coords}${accuracy}`;
  }

  return `📍 ${coords}${accuracy}`;
}

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
