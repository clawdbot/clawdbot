import fs from "node:fs";
import path from "node:path";
import { normalizeProviderId } from "../agents/provider-id.js";
import type { ModelProviderConfig } from "../config/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveBundledPluginsDir } from "./bundled-dir.js";
import type {
  ProviderApplyConfigDefaultsContext,
  ProviderNormalizeConfigContext,
  ProviderResolveConfigApiKeyContext,
} from "./provider-config-context.types.js";
import type {
  ProviderDefaultThinkingPolicyContext,
  ProviderThinkingProfile,
} from "./provider-thinking.types.js";
import { loadBundledPluginPublicArtifactModuleSync } from "./public-surface-loader.js";

const PROVIDER_POLICY_ARTIFACT_CANDIDATES = ["provider-policy-api.js"] as const;
const providerPolicyPluginIdsByProviderId = new Map<string, string | null>();

export type BundledProviderPolicySurface = {
  normalizeConfig?: (ctx: ProviderNormalizeConfigContext) => ModelProviderConfig | null | undefined;
  applyConfigDefaults?: (
    ctx: ProviderApplyConfigDefaultsContext,
  ) => OpenClawConfig | null | undefined;
  resolveConfigApiKey?: (ctx: ProviderResolveConfigApiKeyContext) => string | null | undefined;
  resolveThinkingProfile?: (
    ctx: ProviderDefaultThinkingPolicyContext,
  ) => ProviderThinkingProfile | null | undefined;
};

function hasProviderPolicyHook(
  mod: Record<string, unknown>,
): mod is Record<string, unknown> & BundledProviderPolicySurface {
  return (
    typeof mod.normalizeConfig === "function" ||
    typeof mod.applyConfigDefaults === "function" ||
    typeof mod.resolveConfigApiKey === "function" ||
    typeof mod.resolveThinkingProfile === "function"
  );
}

function tryLoadBundledProviderPolicySurface(
  pluginId: string,
): BundledProviderPolicySurface | null {
  for (const artifactBasename of PROVIDER_POLICY_ARTIFACT_CANDIDATES) {
    try {
      const mod = loadBundledPluginPublicArtifactModuleSync<Record<string, unknown>>({
        dirName: pluginId,
        artifactBasename,
        installRuntimeDeps: false,
      });
      if (hasProviderPolicyHook(mod)) {
        return mod;
      }
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.startsWith("Unable to resolve bundled plugin public surface ")
      ) {
        continue;
      }
      throw error;
    }
  }
  return null;
}

function resolveBundledProviderPolicyPluginId(providerId: string): string | null {
  const normalizedProviderId = normalizeProviderId(providerId);
  if (!normalizedProviderId) {
    return null;
  }
  const bundledPluginsDir = resolveBundledPluginsDir();
  const cacheKey = `${bundledPluginsDir ?? "<none>"}::${normalizedProviderId}`;
  if (providerPolicyPluginIdsByProviderId.has(cacheKey)) {
    return providerPolicyPluginIdsByProviderId.get(cacheKey) ?? null;
  }

  if (!bundledPluginsDir || !fs.existsSync(bundledPluginsDir)) {
    providerPolicyPluginIdsByProviderId.set(cacheKey, null);
    return null;
  }

  for (const entry of fs
    .readdirSync(bundledPluginsDir, { withFileTypes: true })
    .filter((candidate) => candidate.isDirectory())
    .map((candidate) => candidate.name)
    .toSorted((left, right) => left.localeCompare(right))) {
    const manifestPath = path.join(bundledPluginsDir, entry, "openclaw.plugin.json");
    if (!fs.existsSync(manifestPath)) {
      continue;
    }
    let manifest: { providers?: unknown };
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as { providers?: unknown };
    } catch {
      continue;
    }
    const providers = Array.isArray(manifest.providers) ? manifest.providers : [];
    const ownsProvider = providers.some(
      (candidate) =>
        typeof candidate === "string" && normalizeProviderId(candidate) === normalizedProviderId,
    );
    if (ownsProvider) {
      providerPolicyPluginIdsByProviderId.set(cacheKey, entry);
      return entry;
    }
  }

  providerPolicyPluginIdsByProviderId.set(cacheKey, null);
  return null;
}

export function resolveBundledProviderPolicySurface(
  providerId: string,
): BundledProviderPolicySurface | null {
  const normalizedProviderId = normalizeProviderId(providerId);
  if (!normalizedProviderId) {
    return null;
  }
  return (
    tryLoadBundledProviderPolicySurface(normalizedProviderId) ??
    tryLoadBundledProviderPolicySurface(
      resolveBundledProviderPolicyPluginId(normalizedProviderId) ?? normalizedProviderId,
    )
  );
}
