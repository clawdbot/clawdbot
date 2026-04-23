import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizePluginsConfig, resolveEffectiveEnableState } from "../plugins/config-state.js";
import { resolveProviderInstallCatalogEntries } from "../plugins/provider-install-catalog.js";
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
  source: "runtime" | "install-catalog";
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

function resolveInstallCatalogProviderSetupFlowContributions(params?: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  scope?: ProviderFlowScope;
}): ProviderSetupFlowContribution[] {
  const scope = params?.scope ?? DEFAULT_PROVIDER_FLOW_SCOPE;
  const normalizedPluginsConfig = normalizePluginsConfig(params?.config?.plugins);
  return resolveProviderInstallCatalogEntries({
    ...params,
    includeUntrustedWorkspacePlugins: false,
  })
    .filter(
      (entry) =>
        includesProviderFlowScope(entry.onboardingScopes, scope) &&
        resolveEffectiveEnableState({
          id: entry.pluginId,
          origin: entry.origin,
          config: normalizedPluginsConfig,
          rootConfig: params?.config,
          enabledByDefault: true,
        }).enabled,
    )
    .map((entry) => {
      const groupId = entry.groupId ?? entry.providerId;
      const groupLabel = entry.groupLabel ?? entry.label;
      return Object.assign(
        {
          id: `provider:setup:${entry.choiceId}`,
          kind: `provider` as const,
          surface: `setup` as const,
          providerId: entry.providerId,
          pluginId: entry.pluginId,
          option: {
            value: entry.choiceId,
            label: entry.choiceLabel,
            ...(entry.choiceHint ? { hint: entry.choiceHint } : {}),
            ...(entry.assistantPriority !== undefined
              ? { assistantPriority: entry.assistantPriority }
              : {}),
            ...(entry.assistantVisibility
              ? { assistantVisibility: entry.assistantVisibility }
              : {}),
            group: {
              id: groupId,
              label: groupLabel,
              ...(entry.groupHint ? { hint: entry.groupHint } : {}),
            },
          },
        },
        entry.onboardingScopes ? { onboardingScopes: [...entry.onboardingScopes] } : {},
        { source: `install-catalog` as const },
      );
    });
}

export function resolveProviderSetupFlowContributions(params?: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  scope?: ProviderFlowScope;
}): ProviderSetupFlowContribution[] {
  const scope = params?.scope ?? DEFAULT_PROVIDER_FLOW_SCOPE;
  const docsByProvider = resolveProviderDocsById(params ?? {});
  const runtimeContributions = resolveProviderWizardOptions(params ?? {})
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
    );
  const seenOptionValues = new Set(
    runtimeContributions.map((contribution) => contribution.option.value),
  );
  const installCatalogContributions = resolveInstallCatalogProviderSetupFlowContributions({
    ...params,
    scope,
  }).filter((contribution) => !seenOptionValues.has(contribution.option.value));
  return sortFlowContributionsByLabel([...runtimeContributions, ...installCatalogContributions]);
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
