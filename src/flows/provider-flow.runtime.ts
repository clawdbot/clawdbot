import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  resolveProviderModelPickerEntries,
  type ProviderModelPickerEntry,
} from "../plugins/provider-wizard.js";
import { resolvePluginProviders } from "../plugins/providers.runtime.js";
import type { ProviderPlugin } from "../plugins/types.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import type { FlowContribution } from "./types.js";
import { sortFlowContributionsByLabel } from "./types.js";

export type ProviderModelPickerFlowEntry = ProviderModelPickerEntry;

export type ProviderModelPickerFlowContribution = FlowContribution & {
  kind: "provider";
  surface: "model-picker";
  providerId: string;
  option: ProviderModelPickerFlowEntry;
  source: "runtime";
};

function resolveProviderDocsById(params?: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}): Map<string, string> {
  return new Map(
    resolvePluginProviders({
      config: params?.config,
      workspaceDir: params?.workspaceDir,
      env: params?.env,
      mode: "setup",
    })
      .filter((provider): provider is ProviderPlugin & { docsPath: string } =>
        Boolean(normalizeOptionalString(provider.docsPath)),
      )
      .map((provider) => [provider.id, normalizeOptionalString(provider.docsPath)!]),
  );
}

export function resolveProviderModelPickerFlowEntries(params?: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}): ProviderModelPickerFlowEntry[] {
  return resolveProviderModelPickerFlowContributions(params).map(
    (contribution) => contribution.option,
  );
}

export function resolveProviderModelPickerFlowContributions(params?: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}): ProviderModelPickerFlowContribution[] {
  const docsByProvider = resolveProviderDocsById(params ?? {});
  return sortFlowContributionsByLabel(
    resolveProviderModelPickerEntries(params ?? {}).map((entry) => {
      const providerId = entry.value.startsWith("provider-plugin:")
        ? entry.value.slice("provider-plugin:".length).split(":")[0]
        : entry.value;
      return {
        id: `provider:model-picker:${entry.value}`,
        kind: "provider" as const,
        surface: "model-picker" as const,
        providerId,
        option: {
          value: entry.value,
          label: entry.label,
          ...(entry.hint ? { hint: entry.hint } : {}),
          ...(docsByProvider.get(providerId)
            ? { docs: { path: docsByProvider.get(providerId)! } }
            : {}),
        },
        source: "runtime" as const,
      };
    }),
  );
}
