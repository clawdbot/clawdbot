import { DIFF_INDICATORS, DIFF_LAYOUTS, DIFF_THEMES } from "./types.js";
import type { DiffViewerPayload } from "./types.js";

const OVERFLOW_VALUES = ["scroll", "wrap"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseViewerPayloadJson(raw: string): DiffViewerPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Diff payload is not valid JSON.");
  }

  if (!isDiffViewerPayload(parsed)) {
    throw new Error("Diff payload has invalid shape.");
  }

  return parsed;
}

function isDiffViewerPayload(value: unknown): value is DiffViewerPayload {
  if (!isRecord(value)) {
    return false;
  }

  if (typeof value.prerenderedHTML !== "string") {
    return false;
  }

  if (!Array.isArray(value.langs) || !value.langs.every((lang) => typeof lang === "string")) {
    return false;
  }

  if (!isViewerOptions(value.options)) {
    return false;
  }

  const hasFileDiff = isRecord(value.fileDiff);
  const hasBeforeAfterFiles = isRecord(value.oldFile) && isRecord(value.newFile);
  if (!hasFileDiff && !hasBeforeAfterFiles) {
    return false;
  }

  return true;
}

function isViewerOptions(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }

  if (!isRecord(value.theme)) {
    return false;
  }
  if (value.theme.light !== "pierre-light" || value.theme.dark !== "pierre-dark") {
    return false;
  }

  if (!includesValue(DIFF_LAYOUTS, value.diffStyle)) {
    return false;
  }
  if (!includesValue(DIFF_INDICATORS, value.diffIndicators)) {
    return false;
  }
  if (!includesValue(DIFF_THEMES, value.themeType)) {
    return false;
  }
  if (!includesValue(OVERFLOW_VALUES, value.overflow)) {
    return false;
  }

  if (typeof value.disableLineNumbers !== "boolean") {
    return false;
  }
  if (typeof value.expandUnchanged !== "boolean") {
    return false;
  }
  if (typeof value.backgroundEnabled !== "boolean") {
    return false;
  }
  if (typeof value.unsafeCSS !== "string") {
    return false;
  }

  return true;
}

function includesValue<T extends readonly string[]>(values: T, value: unknown): value is T[number] {
  return typeof value === "string" && values.includes(value as T[number]);
}
