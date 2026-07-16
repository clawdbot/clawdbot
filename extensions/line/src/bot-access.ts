import {
  firstDefined,
  isSenderIdAllowed,
  mergeDmAllowFromSources,
} from "openclaw/plugin-sdk/allow-from";

export type NormalizedAllowFrom = {
  entries: string[];
  hasWildcard: boolean;
  hasEntries: boolean;
};

function normalizeAllowEntry(value: string | number): string {
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
  const entries = (list ?? []).map((value) => normalizeAllowEntry(value)).filter(Boolean);
  const hasWildcard = entries.includes("*");
  return {
    entries,
    hasWildcard,
    hasEntries: entries.length > 0,
  };
};

export const normalizeDmAllowFromWithStore = (params: {
  allowFrom?: Array<string | number>;
  storeAllowFrom?: string[];
  dmPolicy?: string;
}): NormalizedAllowFrom => normalizeAllowFrom(mergeDmAllowFromSources(params));

export const isSenderAllowed = (params: {
  allow: NormalizedAllowFrom;
  senderId?: string;
}): boolean => {
  const { allow, senderId } = params;
  return isSenderIdAllowed(allow, senderId, false);
};

export { firstDefined };
