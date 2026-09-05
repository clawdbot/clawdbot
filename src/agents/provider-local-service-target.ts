import { isCanonicalDottedDecimalIPv4, isLoopbackIpAddress } from "@openclaw/net-policy/ip";
import type { ModelProviderLocalServiceConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ProviderLocalServiceReconciler } from "./provider-local-service-reconcile.js";

/** Exact provider endpoint whose optional local process should be leased. */
export type ProviderLocalServiceTarget = {
  providerId: string;
  baseUrl: string;
  headers?: HeadersInit;
  service?: ModelProviderLocalServiceConfig;
  reconcile?: ProviderLocalServiceReconciler;
};

/** Configured provider endpoint whose host-owned local service may be leased. */
export type ConfiguredProviderLocalServiceTarget = Omit<ProviderLocalServiceTarget, "service">;

/** Lease returned for a started or already-running local provider service. */
export type ProviderLocalServiceLease = { release: () => void };

/** Host-injected acquisition hook that cannot supply process configuration. */
export type AcquireConfiguredProviderLocalService = (
  target: ConfiguredProviderLocalServiceTarget,
  signal?: AbortSignal | null,
) => Promise<ProviderLocalServiceLease | undefined>;

export function resolveConfiguredProviderLocalServiceTarget(
  config: OpenClawConfig,
  target: ConfiguredProviderLocalServiceTarget,
): ProviderLocalServiceTarget | undefined {
  const provider = config.models?.providers?.[target.providerId];
  if (!provider?.localService) {
    return undefined;
  }
  if (!isConfiguredProviderBaseUrl(target.baseUrl, readConfiguredProviderBaseUrl(provider))) {
    throw new Error(`Local endpoint must match models.providers.${target.providerId}.baseUrl`);
  }
  return { ...target, service: provider.localService };
}

function readConfiguredProviderBaseUrl(
  provider: { baseUrl?: string; baseURL?: unknown } | undefined,
): string | undefined {
  const baseUrl = provider?.baseUrl?.trim();
  const baseURL = typeof provider?.baseURL === "string" ? provider.baseURL.trim() : "";
  return baseUrl || baseURL || undefined;
}

function normalizeProviderBaseUrl(value: string): string | undefined {
  const trimmed = value.trim();
  const candidate = /^[a-z][a-z\d+.-]*:\/\//iu.test(trimmed) ? trimmed : `http://${trimmed}`;
  try {
    const url = new URL(candidate);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return undefined;
    }
    url.search = "";
    url.hash = "";
    url.pathname = url.pathname.replace(/\/+$/u, "") || "/";
    return url.toString().replace(/\/$/u, "");
  } catch {
    return undefined;
  }
}

function configuredProviderBaseUrlVariants(value: string): Set<string> {
  const normalized = normalizeProviderBaseUrl(value);
  const root = normalized?.replace(/\/v1$/iu, "");
  return normalized && root ? new Set([normalized, root, `${root}/v1`]) : new Set();
}

function isLoopbackProviderBaseUrl(value: string): boolean {
  const normalized = normalizeProviderBaseUrl(value);
  if (!normalized) {
    return false;
  }
  const hostname = new URL(normalized).hostname.toLowerCase();
  if (hostname === "localhost" || hostname === "[::1]") {
    return true;
  }
  return isCanonicalDottedDecimalIPv4(hostname) && isLoopbackIpAddress(hostname);
}

function isConfiguredProviderBaseUrl(targetBaseUrl: string, configuredBaseUrl?: string): boolean {
  const target = normalizeProviderBaseUrl(targetBaseUrl);
  if (!target) {
    return false;
  }
  const configured = configuredBaseUrl?.trim();
  if (!configured) {
    return isLoopbackProviderBaseUrl(target);
  }
  return configuredProviderBaseUrlVariants(configured).has(target);
}
