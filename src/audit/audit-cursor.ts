import { parseStrictPositiveInteger } from "@openclaw/normalization-core/number-coercion";

/** Parse the digit-only positive cursor grammar shared by audit CLI and Gateway paging. */
export function parsePositiveAuditCursor(cursor: string | undefined): number | undefined | null {
  if (cursor === undefined) {
    return undefined;
  }
  const trimmed = cursor.trim();
  if (!/^\d+$/.test(trimmed)) {
    return null;
  }
  return parseStrictPositiveInteger(trimmed) ?? null;
}
