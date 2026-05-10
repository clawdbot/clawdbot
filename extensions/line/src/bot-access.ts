import { firstDefined } from "openclaw/plugin-sdk/allow-from";

export type NormalizedAllowFrom = {
  entries: string[];
  hasWildcard: boolean;
  hasEntries: boolean;
};

export function normalizeLineAllowEntry(value: string | number): string {
  const trimmed = String(value).trim();
  if (!trimmed) {
    return "";
  }
  if (trimmed === "*") {
    return "*";
  }
  return trimmed.replace(/^line:(?:user:)?/i, "");
}

export const normalizeAllowFrom = (list?: Array<string | number>): NormalizedAllowFrom => {
  const entries = (list ?? []).map((value) => normalizeLineAllowEntry(value)).filter(Boolean);
  const hasWildcard = entries.includes("*");
  return {
    entries,
    hasWildcard,
    hasEntries: entries.length > 0,
  };
};

export { firstDefined };
