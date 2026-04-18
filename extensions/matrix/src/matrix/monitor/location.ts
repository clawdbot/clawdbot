import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import type { LocationMessageEventContent } from "../sdk.js";
import { formatLocationText, toLocationContext, type NormalizedLocation } from "./runtime-api.js";
import { EventType } from "./types.js";

export type MatrixLocationPayload = {
  text: string;
  context: ReturnType<typeof toLocationContext>;
};

type GeoUriParams = {
  latitude: number;
  longitude: number;
  accuracy?: number;
};

function parseGeoUri(value: string): GeoUriParams | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  if (!normalizeLowercaseStringOrEmpty(trimmed).startsWith("geo:")) {
    return null;
  }
  const payload = trimmed.slice(4);
  const [coordsPart, ...paramParts] = payload.split(";");
  const coords = coordsPart.split(",");
  if (coords.length < 2) {
    return null;
  }
  const latitude = Number.parseFloat(coords[0] ?? "");
  const longitude = Number.parseFloat(coords[1] ?? "");
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return null;
  }

  const params = new Map<string, string>();
  for (const part of paramParts) {
    const segment = part.trim();
    if (!segment) {
      continue;
    }
    const eqIndex = segment.indexOf("=");
    const rawKey = eqIndex === -1 ? segment : segment.slice(0, eqIndex);
    const rawValue = eqIndex === -1 ? "" : segment.slice(eqIndex + 1);
    const key = normalizeLowercaseStringOrEmpty(rawKey);
    if (!key) {
      continue;
    }
    const valuePart = rawValue.trim();
    params.set(key, valuePart ? decodeURIComponent(valuePart) : "");
  }

  const accuracyRaw = params.get("u");
  const accuracy = accuracyRaw ? Number.parseFloat(accuracyRaw) : undefined;

  return {
    latitude,
    longitude,
    accuracy: Number.isFinite(accuracy) ? accuracy : undefined,
  };
}

export function resolveMatrixLocation(params: {
  eventType: string;
  content: LocationMessageEventContent;
}): MatrixLocationPayload | null {
  const { eventType, content } = params;
  const isLocation =
    eventType === EventType.Location ||
    (eventType === EventType.RoomMessage && content.msgtype === EventType.Location);
  if (!isLocation) {
    return null;
  }
  const geoUri = normalizeOptionalString(content.geo_uri) ?? "";
  if (!geoUri) {
    return null;
  }
  const parsed = parseGeoUri(geoUri);
  if (!parsed) {
    return null;
  }
  const caption = normalizeOptionalString(content.body) ?? "";
  const location: NormalizedLocation = {
    latitude: parsed.latitude,
    longitude: parsed.longitude,
    accuracy: parsed.accuracy,
    caption: caption || undefined,
    source: "pin",
    isLive: false,
  };

  return {
    text: formatLocationText(location),
    context: toLocationContext(location),
  };
}
