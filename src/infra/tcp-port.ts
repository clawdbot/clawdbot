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

/** Extract the effective `--port` value from command arguments. */
export function parseTcpPortFromArgs(programArguments: string[] | undefined): number | null {
  if (!programArguments?.length) {
    return null;
  }
  let latestPort: number | null = null;
  for (let index = 0; index < programArguments.length; index += 1) {
    const argument = programArguments[index];
    if (argument === "--port") {
      const parsed = parseTcpPort(programArguments[index + 1]);
      if (parsed !== null) {
        latestPort = parsed;
      }
      index += 1;
      continue;
    }
    if (argument?.startsWith("--port=")) {
      const parsed = parseTcpPort(argument.slice("--port=".length));
      if (parsed !== null) {
        latestPort = parsed;
      }
    }
  }
  return latestPort;
}
