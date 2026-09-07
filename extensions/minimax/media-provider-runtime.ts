import type { resolveApiKeyForProvider } from "openclaw/plugin-sdk/provider-auth-runtime";
import type { fetchWithTimeoutGuarded, postJsonRequest } from "openclaw/plugin-sdk/provider-http";
import {
  asOptionalRecord,
  normalizeOptionalString,
  readStringField,
} from "openclaw/plugin-sdk/string-coerce-runtime";

export const DEFAULT_MINIMAX_MEDIA_BASE_URL = "https://api.minimax.io";

export type MinimaxBaseResp = {
  status_code?: number;
  status_msg?: string;
};

export type MinimaxRequestPolicy = Pick<
  Parameters<typeof postJsonRequest>[0],
  "allowPrivateNetwork" | "dispatcherPolicy"
>;

export function resolveMinimaxMediaBaseUrl(
  cfg: Parameters<typeof resolveApiKeyForProvider>[0]["cfg"],
  providerId: string,
): string {
  const configured = normalizeOptionalString(cfg?.models?.providers?.[providerId]?.baseUrl);
  try {
    return configured ? new URL(configured).origin : DEFAULT_MINIMAX_MEDIA_BASE_URL;
  } catch {
    return DEFAULT_MINIMAX_MEDIA_BASE_URL;
  }
}

export function assertMinimaxBaseResp(value: unknown, context: string): void {
  const baseResp = asOptionalRecord(value);
  if (baseResp && typeof baseResp.status_code === "number" && baseResp.status_code !== 0) {
    throw new Error(
      `${context} (${baseResp.status_code}): ${readStringField(baseResp, "status_msg") ?? "unknown error"}`,
    );
  }
}

export function normalizeMinimaxHexAudio(data: string, label: string): string {
  const normalized = data.trim();
  if (!/^[0-9a-f]+$/iu.test(normalized) || normalized.length % 2 !== 0) {
    throw new Error(`${label} returned malformed hex audio`);
  }
  return normalized;
}

export function resolveMinimaxGuardedRequestOptions(
  policy: MinimaxRequestPolicy,
): Parameters<typeof fetchWithTimeoutGuarded>[4] | undefined {
  return policy.allowPrivateNetwork || policy.dispatcherPolicy
    ? {
        ...(policy.allowPrivateNetwork ? { ssrfPolicy: { allowPrivateNetwork: true } } : {}),
        ...(policy.dispatcherPolicy ? { dispatcherPolicy: policy.dispatcherPolicy } : {}),
      }
    : undefined;
}
