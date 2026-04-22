import { normalizeOptionalString } from "../../shared/string-coerce.js";

export function extractSimpleExplicitGroupId(raw: string | undefined | null): string | undefined {
  const trimmed = normalizeOptionalString(raw) ?? "";
  if (!trimmed) {
    return undefined;
  }
  const parts = trimmed.split(":").filter(Boolean);
  if (parts.length >= 3 && (parts[1] === "group" || parts[1] === "channel")) {
    const joined = parts.slice(2).join(":");
    return joined.replace(/:topic:.*$/, "") || undefined;
  }
  if (parts.length >= 2 && (parts[0] === "group" || parts[0] === "channel")) {
    const joined = parts.slice(1).join(":");
    return joined.replace(/:topic:.*$/, "") || undefined;
  }
  return undefined;
}
