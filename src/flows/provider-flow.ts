import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizePluginsConfig, resolveEffectiveEnableState } from "../plugins/config-state.js";
import { resolveManifestProviderAuthChoices } from "../plugins/provider-auth-choices.js";
import { resolveProviderInstallCatalogEntries } from "../plugins/provider-install-catalog.js";
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
  source: "manifest" | "install-catalog";
};

function includesProviderFlowScope(
  scopes: readonly ProviderFlowScope[] | undefined,
  scope: ProviderFlowScope,
): boolean {
  return scopes ? scopes.includes(scope) : scope === DEFAULT_PROVIDER_FLOW_SCOPE;
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

function resolveManifestProviderSetupFlowContributions(params?: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  scope?: ProviderFlowScope;
}): ProviderSetupFlowContribution[] {
  const scope = params?.scope ?? DEFAULT_PROVIDER_FLOW_SCOPE;
  return resolveManifestProviderAuthChoices({
    ...params,
    includeUntrustedWorkspacePlugins: false,
  })
    .filter((choice) => includesProviderFlowScope(choice.onboardingScopes, scope))
    .map((choice) => {
      const groupId = choice.groupId ?? choice.providerId;
      const groupLabel = choice.groupLabel ?? choice.choiceLabel;
      return Object.assign(
        {
          id: `provider:setup:${choice.choiceId}`,
          kind: `provider` as const,
          surface: `setup` as const,
          providerId: choice.providerId,
          pluginId: choice.pluginId,
          option: {
            value: choice.choiceId,
            label: choice.choiceLabel,
            ...(choice.choiceHint ? { hint: choice.choiceHint } : {}),
            ...(choice.assistantPriority !== undefined
              ? { assistantPriority: choice.assistantPriority }
              : {}),
            ...(choice.assistantVisibility
              ? { assistantVisibility: choice.assistantVisibility }
              : {}),
            group: {
              id: groupId,
              label: groupLabel,
              ...(choice.groupHint ? { hint: choice.groupHint } : {}),
            },
          },
        },
        choice.onboardingScopes ? { onboardingScopes: [...choice.onboardingScopes] } : {},
        { source: `manifest` as const },
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
  const manifestContributions = resolveManifestProviderSetupFlowContributions({
    ...params,
    scope,
  });
  const seenOptionValues = new Set(
    manifestContributions.map((contribution) => contribution.option.value),
  );
  const installCatalogContributions = resolveInstallCatalogProviderSetupFlowContributions({
    ...params,
    scope,
  }).filter((contribution) => !seenOptionValues.has(contribution.option.value));
  return sortFlowContributionsByLabel([...manifestContributions, ...installCatalogContributions]);
}

export { includesProviderFlowScope };
