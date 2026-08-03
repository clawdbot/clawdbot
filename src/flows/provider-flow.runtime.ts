import { expectDefined } from "@openclaw/normalization-core";
// Provider flow runtime helpers load provider setup behavior behind runtime imports.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import * as providerWizard from "../plugins/provider-wizard.js";
import type { ProviderModelPickerEntry } from "../plugins/provider-wizard.js";
import * as providersRuntime from "../plugins/providers.runtime.js";
import type { ProviderPlugin } from "../plugins/types.js";
import type { FlowContribution } from "./types.js";
import { sortFlowContributionsByLabel } from "./types.js";

// Runtime-backed provider entries for model-picker setup flows.
type ProviderModelPickerFlowEntry = ProviderModelPickerEntry;

type ProviderModelPickerFlowContribution = FlowContribution & {
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
    providersRuntime
      .resolvePluginProviders({
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

/** Resolves provider model-picker options without exposing contribution metadata. */
export function resolveProviderModelPickerFlowEntries(params?: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}): ProviderModelPickerFlowEntry[] {
  return resolveProviderModelPickerFlowContributions(params).map(
    (contribution) => contribution.option,
  );
}

/** Resolves provider model-picker contributions with docs metadata for setup UIs. */
export function resolveProviderModelPickerFlowContributions(params?: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}): ProviderModelPickerFlowContribution[] {
  const docsByProvider = resolveProviderDocsById(params ?? {});
  return sortFlowContributionsByLabel(
    providerWizard.resolveProviderModelPickerEntries(params ?? {}).map((entry) => {
      const providerId = entry.value.startsWith("provider-plugin:")
        ? expectDefined(
            entry.value.slice("provider-plugin:".length).split(":").at(0),
            "provider id",
          )
        : entry.value;
      const docsPath = docsByProvider.get(providerId);
      // Provider-plugin values encode plugin/provider in the option value; docs attach by provider id.
      return {
        id: `provider:model-picker:${entry.value}`,
        kind: "provider" as const,
        surface: "model-picker" as const,
        providerId,
        option: {
          value: entry.value,
          label: entry.label,
          ...(entry.hint ? { hint: entry.hint } : {}),
          ...(docsPath ? { docs: { path: docsPath } } : {}),
        },
        source: "runtime" as const,
      };
    }),
  );
}
