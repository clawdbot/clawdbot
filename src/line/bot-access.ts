export type NormalizedAllowFrom = {
  entries: string[];
  hasWildcard: boolean;
  hasEntries: boolean;
};

function normalizeAllowEntry(value: string | number): string {
  const trimmed = String(value).trim();
  if (!trimmed) return "";
  if (trimmed === "*") return "*";
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

export const normalizeAllowFromWithStore = (params: {
  allowFrom?: Array<string | number>;
  storeAllowFrom?: string[];
}): NormalizedAllowFrom => {
  const combined = [...(params.allowFrom ?? []), ...(params.storeAllowFrom ?? [])];
  return normalizeAllowFrom(combined);
};

export const firstDefined = <T>(...values: Array<T | undefined>) => {
  for (const value of values) {
    if (typeof value !== "undefined") return value;
  }
  return undefined;
};

export const isSenderAllowed = (params: {
  allow: NormalizedAllowFrom;
  senderId?: string;
}): boolean => {
  const { allow, senderId } = params;
  if (!allow.hasEntries) return false;
  if (allow.hasWildcard) return true;
  if (!senderId) return false;
  return allow.entries.includes(senderId);
};
