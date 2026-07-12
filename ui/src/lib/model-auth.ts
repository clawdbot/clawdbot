// Control UI module implements model auth behavior.
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { ModelAuthStatusProvider, ModelAuthStatusResult } from "../api/types.ts";

const EMPTY_AUTH_STATUS: ModelAuthStatusResult = { ts: 0, providers: [] };

/**
 * True when a provider's auth should be actively monitored on the dashboard.
 *
 * Includes:
 * - Providers with at least one OAuth or bearer-token profile (refreshable
 *   credentials that can expire and need rotation)
 * - Providers with status="missing" (configured-but-not-logged-in — the
 *   server synthesizes these so the UI can prompt for login)
 *
 * Excludes API-key-only providers — their credentials don't expire on a
 * schedule the dashboard can meaningfully monitor.
 *
 * Single source of truth for the chat composer and the sidebar attention
 * chips. Keep consumers in sync by always routing through this helper.
 */
export function isMonitoredAuthProvider(p: ModelAuthStatusProvider): boolean {
  if (p.status === "missing") {
    return true;
  }
  if (!Array.isArray(p.profiles)) {
    return false;
  }
  return p.profiles.some((prof) => prof.type === "oauth" || prof.type === "token");
}

export async function loadModelAuthStatus(
  client: GatewayBrowserClient,
  opts?: { refresh?: boolean },
): Promise<ModelAuthStatusResult> {
  const params = opts?.refresh ? { refresh: true } : {};
  return (
    (await client.request<ModelAuthStatusResult>("models.authStatus", params)) ?? EMPTY_AUTH_STATUS
  );
}
