// Plans first-start plugin convergence without loading the repair/catalog runtime.
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { PluginInstallRecord } from "../../../config/types.plugins.js";
import { inspectBundledPluginStartupMetadata } from "../../../plugins/bundled-plugin-startup-metadata.js";
import { resolveConfiguredGenericEmbeddingProviderId } from "../../../plugins/embedding-provider-config.js";
import { collectConfiguredSpeechProviderIds } from "../../../plugins/gateway-startup-speech-providers.js";
import { loadInstalledPluginIndexInstallRecords } from "../../../plugins/installed-plugin-index-record-reader.js";
import {
  hasOfficialExternalChannelTarget,
  hasOfficialExternalContractTarget,
  hasOfficialExternalProviderTarget,
  hasOfficialExternalWebContractEnvTarget,
  hasOfficialExternalWebSearchTarget,
} from "../../../plugins/official-external-plugin-targets.js";
import { collectConfiguredProviderSelectionIds } from "./configured-provider-selection-ids.js";
import { collectConfiguredRuntimePluginIds } from "./configured-runtime-plugin-installs.js";

export type StartupPluginConvergencePlan = {
  required: boolean;
  installRecords: Record<string, PluginInstallRecord>;
};

function hasPotentialPluginConfig(config: OpenClawConfig, env: NodeJS.ProcessEnv): boolean {
  if (config.plugins?.enabled === false) {
    return false;
  }
  const entries = config.plugins?.entries;
  if (!isRecord(entries)) {
    return false;
  }
  return Object.entries(entries).some(([pluginId, entry]) => {
    if (isRecord(entry) && entry.enabled === false) {
      return false;
    }
    return !inspectBundledPluginStartupMetadata({ pluginId, env });
  });
}

function collectConfiguredMemoryEmbeddingProviderIds(config: OpenClawConfig): ReadonlySet<string> {
  const providerIds = new Set<string>();
  const add = (value: unknown) => {
    const providerId = normalizeOptionalLowercaseString(value);
    if (!providerId || providerId === "none" || providerId === "auto") {
      return;
    }
    providerIds.add(providerId);
    const ownerId = resolveConfiguredGenericEmbeddingProviderId(providerId, config);
    if (ownerId) {
      providerIds.add(ownerId);
    }
  };
  const defaults = config.agents?.defaults?.memorySearch;
  if (defaults?.enabled !== false) {
    add(defaults?.provider);
    add(defaults?.fallback);
  }
  for (const agent of config.agents?.list ?? []) {
    if (agent.memorySearch?.enabled === false) {
      continue;
    }
    add(agent.memorySearch?.provider ?? defaults?.provider);
    add(agent.memorySearch?.fallback ?? defaults?.fallback);
  }
  return providerIds;
}

function hasConfiguredCapabilityPlugin(config: OpenClawConfig, env: NodeJS.ProcessEnv): boolean {
  const memoryEmbeddingProviderIds = collectConfiguredMemoryEmbeddingProviderIds(config);
  if (memoryEmbeddingProviderIds.size > 0) {
    if (
      hasOfficialExternalContractTarget({
        contract: "memoryEmbeddingProviders",
        providerIds: memoryEmbeddingProviderIds,
      })
    ) {
      return true;
    }
  }
  const speechProviderIds = collectConfiguredSpeechProviderIds(config);
  if (
    hasOfficialExternalContractTarget({
      contract: "speechProviders",
      providerIds: speechProviderIds,
    })
  ) {
    return true;
  }
  const webFetchProviderId = normalizeOptionalLowercaseString(config.tools?.web?.fetch?.provider);
  if (
    webFetchProviderId &&
    hasOfficialExternalContractTarget({
      contract: "webFetchProviders",
      providerIds: new Set([webFetchProviderId]),
    })
  ) {
    return true;
  }
  return hasOfficialExternalWebContractEnvTarget({
    contract: "webFetchProviders",
    env,
  });
}

/** True when config or environment state can require a missing managed plugin repair. */
export function configMayRequireStartupPluginConvergence(params: {
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
}): boolean {
  if (params.config.plugins?.enabled === false) {
    return false;
  }
  if (hasPotentialPluginConfig(params.config, params.env)) {
    return true;
  }
  if (collectConfiguredRuntimePluginIds(params.config).length > 0) {
    return true;
  }
  if (
    hasOfficialExternalProviderTarget({
      providerIds: collectConfiguredProviderSelectionIds(params.config),
      env: params.env,
    })
  ) {
    return true;
  }
  if (hasOfficialExternalChannelTarget(params)) {
    return true;
  }
  const webSearchProvider = params.config.tools?.web?.search?.provider;
  if (
    params.config.tools?.web?.search?.enabled !== false &&
    hasOfficialExternalWebSearchTarget({
      providerId: typeof webSearchProvider === "string" ? webSearchProvider : undefined,
      env: params.env,
    })
  ) {
    return true;
  }
  return hasConfiguredCapabilityPlugin(params.config, params.env);
}

/** Carries the canonical install-record snapshot into the expensive convergence pass. */
export async function planStartupPluginConvergence(params: {
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
}): Promise<StartupPluginConvergencePlan> {
  const installRecords = await loadInstalledPluginIndexInstallRecords({ env: params.env });
  return {
    required:
      Object.keys(installRecords).length > 0 || configMayRequireStartupPluginConvergence(params),
    installRecords,
  };
}
