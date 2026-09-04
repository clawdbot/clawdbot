import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";

export function normalizeGatewayModelCapabilityBaseUrl(
  value: string | undefined,
): string | undefined {
  const baseUrl = normalizeOptionalString(value);
  if (!baseUrl) {
    return undefined;
  }
  try {
    const parsed = new URL(baseUrl);
    parsed.pathname = parsed.pathname.replace(/\/+$/u, "") || "/";
    return parsed.toString();
  } catch {
    return baseUrl.replace(/\/+$/u, "");
  }
}
