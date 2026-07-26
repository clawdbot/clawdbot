import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import type { PluginManifestRecord } from "./manifest-registry.js";
import type {
  PluginManifestProviderEndpoint,
  PluginManifestProviderRequestProvider,
} from "./manifest.js";
import { listOfficialExternalProviderEndpointManifests } from "./official-external-provider-endpoints.js";

const PROVIDER_ENDPOINT_CLASSES = new Set(
  "anthropic-public cerebras-native chutes-native deepseek-native github-copilot-native groq-native meta-native mistral-public minimax-native moonshot-native modelstudio-native nvidia-native openai-public openai opencode-native azure-openai openrouter xai-native xiaomi-native zai-native google-generative-ai google-vertex".split(
    " ",
  ),
);

function normalizeProviderHosts(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.trim().toLowerCase())
        .filter(Boolean)
    : [];
}

export function normalizePluginProviderBaseUrl(value: string): string | undefined {
  const trimmed = normalizeOptionalString(value);
  const schemeless = trimmed && /^[a-z0-9.[\]-]+(?::\d+)?(?:[/?#].*)?$/i.test(trimmed);
  const url = trimmed ? URL.parse(schemeless ? `https://${trimmed}` : trimmed) : null;
  if (!url || (url.protocol !== "http:" && url.protocol !== "https:")) {
    return undefined;
  }
  url.hash = "";
  url.search = "";
  return normalizeOptionalLowercaseString(url.toString().replace(/\/+$/, ""));
}

function prepareProviderEndpoints(value: unknown): PluginManifestProviderEndpoint[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter(isRecord)
    .filter((endpoint) => {
      const endpointClass = normalizeOptionalString(endpoint.endpointClass);
      return endpointClass ? PROVIDER_ENDPOINT_CLASSES.has(endpointClass) : false;
    })
    .map((endpoint) => {
      const endpointClass = normalizeOptionalString(endpoint.endpointClass)!;
      const googleVertexRegion = normalizeOptionalString(endpoint.googleVertexRegion);
      const googleVertexRegionHostSuffix = normalizeOptionalString(
        endpoint.googleVertexRegionHostSuffix,
      )?.toLowerCase();
      return Object.assign(
        {
          endpointClass,
          hosts: normalizeProviderHosts(endpoint.hosts),
          hostSuffixes: normalizeProviderHosts(endpoint.hostSuffixes),
          baseUrls: normalizeProviderHosts(endpoint.baseUrls)
            .map(normalizePluginProviderBaseUrl)
            .filter((baseUrl): baseUrl is string => baseUrl !== undefined),
        },
        googleVertexRegion ? { googleVertexRegion } : {},
        googleVertexRegionHostSuffix ? { googleVertexRegionHostSuffix } : {},
      );
    });
}

export function buildPluginMetadataProviderFacts(plugins: readonly PluginManifestRecord[]) {
  const providerEndpoints = plugins.flatMap((plugin) =>
    prepareProviderEndpoints(plugin.providerEndpoints),
  );
  const providerRequests = new Map<string, PluginManifestProviderRequestProvider>();
  for (const plugin of plugins) {
    const requests = isRecord(plugin.providerRequest?.providers)
      ? plugin.providerRequest.providers
      : {};
    for (const [rawProvider, request] of Object.entries(requests)) {
      if (!isRecord(request)) {
        continue;
      }
      const provider = normalizeLowercaseStringOrEmpty(rawProvider);
      if (!provider) {
        continue;
      }
      const supportsStreamingUsage = isRecord(request.openAICompletions)
        ? request.openAICompletions.supportsStreamingUsage
        : undefined;
      providerRequests.set(provider, {
        ...(normalizeOptionalString(request.family)
          ? { family: normalizeOptionalString(request.family) }
          : {}),
        ...(normalizeOptionalString(request.compatibilityFamily) === "moonshot"
          ? { compatibilityFamily: "moonshot" as const }
          : {}),
        ...(typeof supportsStreamingUsage === "boolean"
          ? { openAICompletions: { supportsStreamingUsage } }
          : {}),
      });
    }
  }
  for (const manifest of listOfficialExternalProviderEndpointManifests()) {
    providerEndpoints.push(...prepareProviderEndpoints(manifest.providerEndpoints));
  }
  return { providerEndpoints, providerRequests };
}
