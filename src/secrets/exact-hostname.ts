import net from "node:net";
import { domainToASCII } from "node:url";

/**
 * Canonical exact-host contract shared by per-secret destination bindings and the
 * egress-proxy config allowlists: lowercase ASCII/punycode, unbracketed IP literals,
 * no wildcard, scheme, path, or port. Throws with an operator-actionable message so
 * config validation and the secret store surface the same policy.
 */
export function normalizeExactAllowedHost(raw: string): string {
  const trimmed = raw.trim().toLowerCase().replace(/\.+$/u, "");
  if (trimmed.includes("*")) {
    throw new Error(`Allowed host "${raw}" cannot contain a wildcard; use one exact hostname.`);
  }
  const unbracketed =
    trimmed.startsWith("[") && trimmed.endsWith("]") ? trimmed.slice(1, -1) : trimmed;
  if (net.isIP(unbracketed)) {
    return unbracketed;
  }
  if (!unbracketed || unbracketed.includes(":") || /[\s/?#@]/u.test(unbracketed)) {
    throw new Error(
      `Allowed host "${raw}" must be a hostname without a scheme, path, wildcard, or port.`,
    );
  }
  const ascii = domainToASCII(unbracketed);
  if (
    !ascii ||
    ascii.length > 253 ||
    ascii
      .split(".")
      .some(
        (label) =>
          !label ||
          label.length > 63 ||
          label.startsWith("-") ||
          label.endsWith("-") ||
          !/^[a-z0-9-]+$/u.test(label),
      )
  ) {
    throw new Error(`Allowed host "${raw}" is not a valid hostname.`);
  }
  return ascii;
}
