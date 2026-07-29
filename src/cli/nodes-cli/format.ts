// Formatting and parse re-exports for node list/pairing CLI output.
import { normalizeStringifiedOptionalString } from "@openclaw/normalization-core/string-coerce";

export { parseNodeList, parsePairingList } from "../../shared/node-list-parse.js";

/** Format node permission maps as a stable `[permission=yes|no]` label. */
export function formatPermissions(raw: unknown) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const entries = Object.entries(raw as Record<string, unknown>)
    .map(([key, value]) => [normalizeStringifiedOptionalString(key) ?? "", value === true] as const)
    .filter(([key]) => key.length > 0)
    .toSorted((a, b) => a[0].localeCompare(b[0]));
  if (entries.length === 0) {
    return null;
  }
  const parts = entries.map(([key, granted]) => `${key}=${granted ? "yes" : "no"}`);
  return `[${parts.join(", ")}]`;
}
