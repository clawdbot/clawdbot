// Parses strict TCP port inputs for config and CLI surfaces.
import { parseStrictPositiveInteger } from "./parse-finite-number.js";

// TCP port parsing is strict because config and CLI inputs both use this helper.
export const MAX_TCP_PORT = 65_535;

/** Parse a positive TCP port or return null for absent/invalid input. */
export function parseTcpPort(raw: unknown): number | null {
  if (raw === undefined || raw === null) {
    return null;
  }
  const parsed = parseStrictPositiveInteger(raw);
  if (parsed === undefined || parsed > MAX_TCP_PORT) {
    return null;
  }
  return parsed;
}
