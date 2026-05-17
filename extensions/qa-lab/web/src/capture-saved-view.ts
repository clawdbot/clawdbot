import type { CaptureSavedView } from "./ui-render.js";

const MAX_SAVED_VIEWS = 12;
const MAX_FILTER_ITEMS = 64;
const MAX_FILTER_VALUE_LENGTH = 256;
const MAX_NAME_LENGTH = 80;
const MAX_SEARCH_TEXT_LENGTH = 500;

const headerModes = new Set<CaptureSavedView["headerMode"]>(["key", "all", "hidden"]);
const viewModes = new Set<CaptureSavedView["viewMode"]>(["list", "timeline"]);
const groupModes = new Set<CaptureSavedView["groupMode"]>(["none", "flow", "host-path", "burst"]);
const timelineLaneModes = new Set<CaptureSavedView["timelineLaneMode"]>([
  "domain",
  "provider",
  "flow",
]);
const timelineLaneSorts = new Set<CaptureSavedView["timelineLaneSort"]>([
  "most-events",
  "most-errors",
  "severity",
  "alphabetical",
]);
const timelineZooms = new Set<CaptureSavedView["timelineZoom"]>([75, 100, 150, 200, 300]);
const timelineSparklineModes = new Set<CaptureSavedView["timelineSparklineMode"]>([
  "session-relative",
  "lane-relative",
]);
const detailPlacements = new Set<CaptureSavedView["detailPlacement"]>(["right", "bottom"]);
const payloadLayouts = new Set<NonNullable<CaptureSavedView["payloadLayout"]>>([
  "formatted",
  "raw",
]);
const payloadExtents = new Set<CaptureSavedView["payloadExtent"]>(["preview", "full"]);

function readString(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maxLength) : null;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim().slice(0, MAX_FILTER_VALUE_LENGTH))
    .filter(Boolean)
    .slice(0, MAX_FILTER_ITEMS);
}

function readEnum<T extends string>(value: unknown, allowed: Set<T>, fallback: T): T {
  return typeof value === "string" && allowed.has(value as T) ? (value as T) : fallback;
}

function readNullableEnum<T extends string>(value: unknown, allowed: Set<T>): T | null {
  return typeof value === "string" && allowed.has(value as T) ? (value as T) : null;
}

function readTimelineZoom(value: unknown): CaptureSavedView["timelineZoom"] {
  return typeof value === "number" && timelineZooms.has(value as CaptureSavedView["timelineZoom"])
    ? (value as CaptureSavedView["timelineZoom"])
    : 100;
}

export function normalizeCaptureSavedView(value: unknown): CaptureSavedView | null {
  const record =
    typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
  if (!record) {
    return null;
  }
  const id = readString(record.id, MAX_FILTER_VALUE_LENGTH);
  const name = readString(record.name, MAX_NAME_LENGTH);
  if (!id || !name) {
    return null;
  }
  return {
    id,
    name,
    sessionIds: readStringArray(record.sessionIds),
    kindFilter: readStringArray(record.kindFilter),
    providerFilter: readStringArray(record.providerFilter),
    hostFilter: readStringArray(record.hostFilter),
    searchText:
      typeof record.searchText === "string"
        ? record.searchText.slice(0, MAX_SEARCH_TEXT_LENGTH)
        : "",
    headerMode: readEnum(record.headerMode, headerModes, "key"),
    viewMode: readEnum(record.viewMode, viewModes, "list"),
    groupMode: readEnum(record.groupMode, groupModes, "none"),
    timelineLaneMode: readEnum(record.timelineLaneMode, timelineLaneModes, "domain"),
    timelineLaneSort: readEnum(record.timelineLaneSort, timelineLaneSorts, "most-events"),
    timelineZoom: readTimelineZoom(record.timelineZoom),
    timelineSparklineMode: readEnum(
      record.timelineSparklineMode,
      timelineSparklineModes,
      "session-relative",
    ),
    errorsOnly: record.errorsOnly === true,
    detailPlacement: readEnum(record.detailPlacement, detailPlacements, "right"),
    payloadLayout: readNullableEnum(record.payloadLayout, payloadLayouts),
    payloadExtent: readEnum(record.payloadExtent, payloadExtents, "preview"),
  };
}

export function normalizeCaptureSavedViews(value: unknown): CaptureSavedView[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const views: CaptureSavedView[] = [];
  for (const item of value) {
    const view = normalizeCaptureSavedView(item);
    if (view) {
      views.push(view);
    }
    if (views.length >= MAX_SAVED_VIEWS) {
      break;
    }
  }
  return views;
}
