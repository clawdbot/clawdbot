// Shared parser for CLI flags that select a local Gateway TCP port.
import { parseStrictPositiveInteger } from "../infra/parse-finite-number.js";

const MAX_TCP_PORT = 65_535;

export function parseGatewayPortOption(raw: unknown, flagName = "--port"): number | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }

  const value =
    typeof raw === "string"
      ? raw.trim()
      : typeof raw === "number" || typeof raw === "bigint"
        ? String(raw)
        : "";
  if (!value) {
    return undefined;
  }

  const parsed = parseStrictPositiveInteger(value);
  if (parsed === undefined || parsed > MAX_TCP_PORT) {
    throw new Error(`${flagName} must be an integer between 1 and ${MAX_TCP_PORT}.`);
  }
  return parsed;
}
