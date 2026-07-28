// Control UI module normalizes gateway URLs used to scope browser auth state.
import { normalizeOptionalString } from "../lib/string-coerce.ts";

function normalizeGatewayScope(gatewayUrl: string, includeSearch: boolean): string {
  const trimmed = normalizeOptionalString(gatewayUrl) ?? "";
  if (!trimmed) {
    return "default";
  }
  try {
    const base =
      typeof location !== "undefined"
        ? `${location.protocol}//${location.host}${location.pathname || "/"}`
        : undefined;
    const parsed = base ? new URL(trimmed, base) : new URL(trimmed);
    const pathname =
      parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/+$/, "") || parsed.pathname;
    return `${parsed.protocol}//${parsed.host}${pathname}${includeSearch ? parsed.search : ""}`;
  } catch {
    return trimmed;
  }
}

export function normalizeGatewayTokenScope(gatewayUrl: string): string {
  return normalizeGatewayScope(gatewayUrl, false);
}

export function normalizeGatewayCredentialScope(gatewayUrl: string): string {
  return normalizeGatewayScope(gatewayUrl, true);
}
