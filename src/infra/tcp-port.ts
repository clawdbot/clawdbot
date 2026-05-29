import { parseStrictPositiveInteger } from "./parse-finite-number.js";

export const MAX_TCP_PORT = 65_535;

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
