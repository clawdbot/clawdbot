import type { AuthProfileStore } from "../agents/auth-profiles/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveProviderSetupFlowContributions } from "../flows/provider-flow.js";
import {
  CORE_AUTH_CHOICE_OPTIONS,
  type AuthChoiceGroup,
  type AuthChoiceOption,
  formatStaticAuthChoiceChoicesForCli,
} from "./auth-choice-options.static.js";
import type { AuthChoice, AuthChoiceGroupId } from "./onboard-types.js";

function compareOptionLabels(a: AuthChoiceOption, b: AuthChoiceOption): number {
  return a.label.localeCompare(b.label);
}

function compareAssistantOptions(a: AuthChoiceOption, b: AuthChoiceOption): number {
  const priorityA = a.assistantPriority ?? 0;
  const priorityB = b.assistantPriority ?? 0;
  return priorityA - priorityB || compareOptionLabels(a, b);
}

function compareGroupLabels(a: AuthChoiceGroup, b: AuthChoiceGroup): number {
  return a.label.localeCompare(b.label);
}

function resolveProviderChoiceOptions(params?: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}): AuthChoiceOption[] {
  return resolveProviderSetupFlowContributions({
    ...params,
    scope: "text-inference",
  }).map((contribution) => ({
    value: contribution.option.value as AuthChoice,
    label: contribution.option.label,
    ...(contribution.option.hint ? { hint: contribution.option.hint } : {}),
    ...(contribution.option.assistantPriority !== undefined
      ? { assistantPriority: contribution.option.assistantPriority }
      : {}),
    ...(contribution.option.assistantVisibility
      ? { assistantVisibility: contribution.option.assistantVisibility }
      : {}),
    ...(contribution.option.group
      ? {
          groupId: contribution.option.group.id as AuthChoiceGroupId,
          groupLabel: contribution.option.group.label,
          ...(contribution.option.group.hint ? { groupHint: contribution.option.group.hint } : {}),
        }
      : {}),
  }));
}

export function formatAuthChoiceChoicesForCli(params?: {
  includeSkip?: boolean;
  includeLegacyAliases?: boolean;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}): string {
  const values = [
    ...formatStaticAuthChoiceChoicesForCli(params).split("|"),
    ...resolveProviderSetupFlowContributions({
      ...params,
      scope: "text-inference",
    }).map((contribution) => contribution.option.value),
  ];

  return [...new Set(values)].join("|");
}

export function buildAuthChoiceOptions(params: {
  store: AuthProfileStore;
  includeSkip: boolean;
  assistantVisibleOnly?: boolean;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}): AuthChoiceOption[] {
  void params.store;
  const optionByValue = new Map<AuthChoice, AuthChoiceOption>();
  for (const option of CORE_AUTH_CHOICE_OPTIONS) {
    optionByValue.set(option.value, option);
  }
  for (const option of resolveProviderChoiceOptions({
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
  })) {
    optionByValue.set(option.value, option);
  }

  const options: AuthChoiceOption[] = Array.from(optionByValue.values())
    .toSorted(compareOptionLabels)
    .filter((option) =>
      params.assistantVisibleOnly ? option.assistantVisibility !== "manual-only" : true,
    );

  if (params.includeSkip) {
    options.push({ value: "skip", label: "Skip for now" });
  }

  return options;
}

export function buildAuthChoiceGroups(params: {
  store: AuthProfileStore;
  includeSkip: boolean;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}): {
  groups: AuthChoiceGroup[];
  skipOption?: AuthChoiceOption;
} {
  const options = buildAuthChoiceOptions({
    ...params,
    includeSkip: false,
    assistantVisibleOnly: true,
  });
  const groupsById = new Map<AuthChoiceGroupId, AuthChoiceGroup>();

  for (const option of options) {
    if (!option.groupId || !option.groupLabel) {
      continue;
    }
    const existing = groupsById.get(option.groupId);
    if (existing) {
      existing.options.push(option);
      continue;
    }
    groupsById.set(option.groupId, {
      value: option.groupId,
      label: option.groupLabel,
      ...(option.groupHint ? { hint: option.groupHint } : {}),
      options: [option],
    });
  }
  const groups = Array.from(groupsById.values())
    .map((group) => ({
      ...group,
      options: [...group.options].toSorted(compareAssistantOptions),
    }))
    .toSorted(compareGroupLabels);

  const skipOption = params.includeSkip
    ? ({ value: "skip", label: "Skip for now" } satisfies AuthChoiceOption)
    : undefined;

  return { groups, skipOption };
}
