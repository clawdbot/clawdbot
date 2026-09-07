// Parse Signal container text-style span entries.
import { parseStrictNonNegativeInteger } from "openclaw/plugin-sdk/number-runtime";

export function parseContainerTextStyleEntry(
  raw: string,
): { start: number; length: number; style: string } | undefined {
  const [startRaw, lengthRaw, style] = raw.split(":");
  if (startRaw === undefined || lengthRaw === undefined || style === undefined) {
    return undefined;
  }
  // Reject hex/exponent so style spans cannot silently shift to wrong positions.
  const start = parseStrictNonNegativeInteger(startRaw);
  const length = parseStrictNonNegativeInteger(lengthRaw);
  if (start === undefined || length === undefined) {
    return undefined;
  }
  return { start, length, style };
}
