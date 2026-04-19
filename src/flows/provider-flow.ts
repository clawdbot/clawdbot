import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  resolveProviderModelPickerEntries,
  resolveProviderWizardOptions,
} from "../plugins/provider-wizard.js";
import { resolvePluginProviders } from "../plugins/providers.runtime.js";
import type { ProviderPlugin } from "../plugins/types.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import type { FlowContribution, FlowOption } from "./types.js";
import { sortFlowContributionsByLabel } from "./types.js";

export type ProviderFlowScope = "text-inference" | "image-generation";

const DEFAULT_PROVIDER_FLOW_SCOPE: ProviderFlowScope = "text-inference";

export type ProviderSetupFlowOption = FlowOption & {
  onboardingScopes?: ProviderFlowScope[];
};

export type ProviderModelPickerFlowEntry = FlowOption;

export type ProviderSetupFlowContribution = FlowContribution & {
  kind: "provider";
  surface: "setup";
  providerId: string;
  pluginId?: string;
  option: ProviderSetupFlowOption;
  onboardingScopes?: ProviderFlowScope[];
  source: "runtime";
};

export type ProviderModelPickerFlowContribution = FlowContribution & {
  kind: "provider";
  surface: "model-picker";
  providerId: string;
  option: ProviderModelPickerFlowEntry;
  source: "runtime";
};

function includesProviderFlowScope(
  scopes: readonly ProviderFlowScope[] | undefined,
  scope: ProviderFlowScope,
): boolean {
  return scopes ? scopes.includes(scope) : scope === DEFAULT_PROVIDER_FLOW_SCOPE;
}

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

export function resolveProviderSetupFlowContributions(params?: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  scope?: ProviderFlowScope;
}): ProviderSetupFlowContribution[] {
  const scope = params?.scope ?? DEFAULT_PROVIDER_FLOW_SCOPE;
  const docsByProvider = resolveProviderDocsById(params ?? {});
  return sortFlowContributionsByLabel(
    resolveProviderWizardOptions(params ?? {})
      .filter((option) => includesProviderFlowScope(option.onboardingScopes, scope))
      .map((option) =>
        Object.assign(
          {
            id: `provider:setup:${option.value}`,
            kind: `provider` as const,
            surface: `setup` as const,
            providerId: option.groupId,
            option: {
              value: option.value,
              label: option.label,
              ...(option.hint ? { hint: option.hint } : {}),
              ...(option.assistantPriority !== undefined
                ? { assistantPriority: option.assistantPriority }
                : {}),
              ...(option.assistantVisibility
                ? { assistantVisibility: option.assistantVisibility }
                : {}),
              group: {
                id: option.groupId,
                label: option.groupLabel,
                ...(option.groupHint ? { hint: option.groupHint } : {}),
              },
              ...(docsByProvider.get(option.groupId)
                ? { docs: { path: docsByProvider.get(option.groupId)! } }
                : {}),
            },
          },
          option.onboardingScopes ? { onboardingScopes: [...option.onboardingScopes] } : {},
          { source: `runtime` as const },
        ),
      ),
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

export { includesProviderFlowScope };
