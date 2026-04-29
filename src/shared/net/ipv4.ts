import { isCanonicalDottedDecimalIPv4 } from "./ip.js";

export function validateDottedDecimalIPv4Input(value: string | undefined): string | undefined {
  if (!value) {
    return "IP address is required for custom bind mode";
  }
  if (isCanonicalDottedDecimalIPv4(value)) {
    return undefined;
  }
  return "Invalid IPv4 address (e.g., 192.168.1.100)";
}

/** @deprecated Use validateDottedDecimalIPv4Input. */
export function validateIPv4AddressInput(value: string | undefined): string | undefined {
  return validateDottedDecimalIPv4Input(value);
}
