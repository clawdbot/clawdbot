import { parseStrictPositiveInteger } from "../../infra/parse-finite-number.js";

// TCP/UDP ports are 16-bit, so 65535 is the max. `parseStrictPositiveInteger`
// only enforces positivity, so values like 99999 were returned as-is and
// reached gateway-cli / node-cli bind paths; the OS then surfaced the error
// instead of the CLI rejecting it cleanly at parse time. See #83900.
const MAX_TCP_PORT = 65_535;

export function parsePort(raw: unknown): number | null {
  if (raw === undefined || raw === null) {
    return null;
  }
  const parsed = parseStrictPositiveInteger(raw);
  if (parsed === undefined || parsed > MAX_TCP_PORT) {
    return null;
  }
  return parsed;
}
