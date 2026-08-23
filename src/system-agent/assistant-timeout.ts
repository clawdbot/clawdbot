// Resolves the system-agent turn budget from manifest-owned provider metadata.
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import type { PluginManifestRecord } from "../plugins/manifest-registry.js";
import { resolvePluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import {
  SYSTEM_AGENT_ASSISTANT_LOCAL_TIMEOUT_MS,
  SYSTEM_AGENT_ASSISTANT_TIMEOUT_MS,
} from "./assistant-prompts.js";
import type { SystemAgentConfiguredRoute } from "./inference-route.js";

type SystemAgentPricingManifest = Pick<PluginManifestRecord, "modelPricing">;

function resolveSystemAgentAssistantTimeoutFromManifests(params: {
  route: Pick<SystemAgentConfiguredRoute, "modelLabel" | "provider">;
  plugins: readonly SystemAgentPricingManifest[];
}): number {
  const providers = new Set([
    normalizeProviderId(params.route.provider),
    normalizeProviderId(params.route.modelLabel.split("/", 1)[0] ?? ""),
  ]);
  const isLocal = params.plugins.some((plugin) =>
    Object.entries(plugin.modelPricing?.providers ?? {}).some(
      ([provider, pricing]) =>
        providers.has(normalizeProviderId(provider)) && pricing.external === false,
    ),
  );
  return isLocal ? SYSTEM_AGENT_ASSISTANT_LOCAL_TIMEOUT_MS : SYSTEM_AGENT_ASSISTANT_TIMEOUT_MS;
}

export function resolveSystemAgentAssistantTimeoutMs(route: SystemAgentConfiguredRoute): number {
  try {
    const workspaceDir = resolveAgentWorkspaceDir(route.runConfig, route.agentId);
    const snapshot = resolvePluginMetadataSnapshot({
      config: route.runConfig,
      workspaceDir,
      env: process.env,
      allowWorkspaceScopedCurrent: true,
    });
    return resolveSystemAgentAssistantTimeoutFromManifests({
      route,
      plugins: snapshot.plugins,
    });
  } catch {
    return SYSTEM_AGENT_ASSISTANT_TIMEOUT_MS;
  }
}

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.systemAgentTimeoutTestApi")] = {
    resolveSystemAgentAssistantTimeoutFromManifests,
  };
}
