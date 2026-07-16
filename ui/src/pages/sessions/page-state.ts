import { parseStrictPositiveInteger } from "@openclaw/normalization-core/number-coercion";
import { normalizeSessionsGroupBy, type SessionsGroupBy } from "../../lib/sessions/grouping.ts";
import { getSafeLocalStorage } from "../../local-storage.ts";

const GROUP_BY_STORAGE_KEY = "openclaw:sessions:group-by";

export function loadStoredGroupBy(): SessionsGroupBy {
  return normalizeSessionsGroupBy(getSafeLocalStorage()?.getItem(GROUP_BY_STORAGE_KEY));
}

export function saveStoredGroupBy(mode: SessionsGroupBy): void {
  try {
    getSafeLocalStorage()?.setItem(GROUP_BY_STORAGE_KEY, mode);
  } catch {
    // Storage may be unavailable or full; the in-memory selection still applies.
  }
}

export function parseFilterInteger(value: string): number | undefined {
  return parseStrictPositiveInteger(value);
}
