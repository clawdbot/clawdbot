// Derives stable group ids from simple channel and conversation facts.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";

/** Extracts a simple group/channel id from stable group-like source ids. */
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
