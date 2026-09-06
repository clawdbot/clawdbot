// Control UI module implements model auth behavior.
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { resolveUsageProviderId } from "../../../src/infra/provider-usage.shared.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { ModelAuthStatusProvider, ModelAuthStatusResult } from "../api/types.ts";

const EMPTY_AUTH_STATUS: ModelAuthStatusResult = { ts: 0, providers: [] };

/** Map credential-runtime aliases onto the provider card/attention identity. */
export function canonicalModelAuthProviderId(provider: string): string {
  const normalized = normalizeProviderId(provider);
  return resolveUsageProviderId(normalized) ?? normalized;
}

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

const AUTH_STATUS_PRIORITY = ["expired", "missing", "expiring", "ok", "static"] as const;

/** Collapse auth aliases before display; Gateway rows retain their auth facts. */
export function listEffectiveModelAuthProviders(
  providers: readonly ModelAuthStatusProvider[],
): ModelAuthStatusProvider[] {
  const groups = new Map<string, ModelAuthStatusProvider[]>();
  for (const provider of providers) {
    const id = canonicalModelAuthProviderId(provider.provider);
    const group = groups.get(id) ?? [];
    group.push(provider);
    groups.set(id, group);
  }
  return [...groups].map(([id, group]) => {
    const selected = group.reduce((worst, candidate) =>
      AUTH_STATUS_PRIORITY.indexOf(candidate.status) < AUTH_STATUS_PRIORITY.indexOf(worst.status)
        ? candidate
        : worst,
    );
    return Object.assign({}, selected, {
      provider: id,
      profiles: group.flatMap((provider) => provider.profiles),
    });
  });
}

export async function loadModelAuthStatus(
  client: GatewayBrowserClient,
  opts: { agentId: string; refresh?: boolean; signal?: AbortSignal },
): Promise<ModelAuthStatusResult> {
  const params = {
    ...(opts?.refresh ? { refresh: true } : {}),
    agentId: opts.agentId,
  };
  const result = opts?.signal
    ? await client.request<ModelAuthStatusResult>("models.authStatus", params, {
        signal: opts.signal,
      })
    : await client.request<ModelAuthStatusResult>("models.authStatus", params);
  return result ?? EMPTY_AUTH_STATUS;
}
