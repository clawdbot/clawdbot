// Network Policy module implements ipv4 behavior.
import { isCanonicalDottedDecimalIPv4 } from "./ip.js";

/** Validates the custom-bind IPv4 input and returns the user-facing error text. */
export function validateDottedDecimalIPv4Input(value: string | undefined): string | undefined {
  if (!value) {
    return "IP address is required for custom bind mode";
  }
  if (isCanonicalDottedDecimalIPv4(value)) {
    return undefined;
  }
  return "Invalid IPv4 address (e.g., 192.168.1.100)";
}
