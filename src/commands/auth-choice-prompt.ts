// Interactive grouped auth-choice prompt used by onboarding and agent setup.
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { expectDefined } from "@openclaw/normalization-core";
import type { AuthProfileStore } from "../agents/auth-profiles/types.js";
import { resolveAgentModelPrimaryValue } from "../config/model-input.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { WizardPrompter, WizardSelectOption } from "../wizard/prompts.js";
import {
  buildAuthChoiceGroups,
  compareAuthChoiceGroups,
  isFeaturedAuthChoiceGroup,
} from "./auth-choice-options.js";
import type { AuthChoiceGroup } from "./auth-choice-options.static.js";
import type { AuthChoice } from "./onboard-types.js";

const BACK_VALUE = "__back";
const MORE_VALUE = "__more";
export const KEEP_CURRENT_AUTH_CHOICE = "__keep-current";

type KeepCurrentAuthChoice = typeof KEEP_CURRENT_AUTH_CHOICE;
type PromptAuthChoiceResult = AuthChoice | KeepCurrentAuthChoice;
type AuthChoiceOrBack = PromptAuthChoiceResult | typeof BACK_VALUE;
type PromptAuthChoiceGroupedParams = {
  prompter: WizardPrompter;
  store: AuthProfileStore;
  includeSkip: boolean;
  assistantVisibleOnly?: boolean;
  allowedChoices?: ReadonlySet<string>;
  additionalGroups?: readonly AuthChoiceGroup[];
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  allowKeepCurrentProvider?: boolean;
};

function resolveConfiguredModelRef(config?: OpenClawConfig): string | undefined {
  return resolveAgentModelPrimaryValue(config?.agents?.defaults?.model);
}

function resolveConfiguredProvider(config?: OpenClawConfig): string | undefined {
  const modelRef = resolveConfiguredModelRef(config);
  const slashIndex = modelRef?.indexOf("/") ?? -1;
  if (!modelRef || slashIndex <= 0) {
    return undefined;
  }
  const provider = normalizeProviderId(modelRef.slice(0, slashIndex));
  return provider || undefined;
}

function groupMatchesProvider(group: AuthChoiceGroup, provider: string | undefined): boolean {
  if (!provider) {
    return false;
  }
  const candidates = [group.value, ...(group.providerIds ?? [])];
  return candidates.some((candidate) => normalizeProviderId(candidate) === provider);
}

function groupToOption(
  group: AuthChoiceGroup,
  configuredProvider: string | undefined,
): WizardSelectOption {
  const configured = groupMatchesProvider(group, configuredProvider);
  return {
    value: group.value,
    label: configured ? `${group.label} (currently configured)` : group.label,
    hint: group.hint,
  };
}

/** Prompt for a provider group and auth method, with fallback flat selection when needed. */
export function promptAuthChoiceGrouped(
  params: PromptAuthChoiceGroupedParams & { allowKeepCurrentProvider: true },
): Promise<PromptAuthChoiceResult>;
export function promptAuthChoiceGrouped(params: PromptAuthChoiceGroupedParams): Promise<AuthChoice>;
export async function promptAuthChoiceGrouped(
  params: PromptAuthChoiceGroupedParams,
): Promise<PromptAuthChoiceResult> {
  const { groups, skipOption } = buildAuthChoiceGroups(params);
  const filteredGroups = params.allowedChoices
    ? groups.map((group) => ({
        ...group,
        options: group.options.filter((option) => params.allowedChoices?.has(option.value)),
      }))
    : groups;
  const availableBuiltInGroups = filteredGroups.filter((group) => group.options.length > 0);
  const additionalGroups = (params.additionalGroups ?? []).filter(
    (group) => group.options.length > 0,
  );
  const availableGroups = [...availableBuiltInGroups, ...additionalGroups];
  const groupById = new Map(availableGroups.map((group) => [group.value, group] as const));
  // Caller-supplied groups carry pre-vetted context such as detected onboarding routes.
  // Keep them ahead of the generic catalog instead of demoting them under More.
  const featuredGroups = [
    ...additionalGroups,
    ...availableBuiltInGroups.filter(isFeaturedAuthChoiceGroup).toSorted(compareAuthChoiceGroups),
  ];
  const moreGroups = availableBuiltInGroups
    .filter((group) => !isFeaturedAuthChoiceGroup(group))
    .toSorted(compareAuthChoiceGroups);
  const configuredModelRef = resolveConfiguredModelRef(params.config);
  const configuredProvider = params.allowKeepCurrentProvider
    ? resolveConfiguredProvider(params.config)
    : undefined;

  const pickMethod = async (group: AuthChoiceGroup): Promise<AuthChoiceOrBack> => {
    const keepCurrentOption = groupMatchesProvider(group, configuredProvider)
      ? ({
          value: KEEP_CURRENT_AUTH_CHOICE,
          label: "Keep current config",
          ...(configuredModelRef ? { hint: `Keep ${configuredModelRef}` } : {}),
        } satisfies WizardSelectOption<KeepCurrentAuthChoice>)
      : undefined;
    if (group.options.length === 1 && !keepCurrentOption) {
      return expectDefined(group.options[0], "options entry at 0").value;
    }
    return (await params.prompter.select({
      message: group.methodMessage ?? `${group.label} auth method`,
      options: [
        ...(keepCurrentOption ? [keepCurrentOption] : []),
        ...group.options,
        { value: BACK_VALUE, label: "Back" },
      ],
    })) as AuthChoiceOrBack;
  };

  const pickFromMore = async (): Promise<AuthChoiceOrBack> => {
    while (true) {
      const options: WizardSelectOption[] = moreGroups.map((group) =>
        groupToOption(group, configuredProvider),
      );
      options.push({ value: BACK_VALUE, label: "Back" });
      const selection = await params.prompter.select({
        message: "Model/auth provider",
        options,
        searchable: true,
      });
      if (selection === BACK_VALUE) {
        return BACK_VALUE;
      }
      const group = groupById.get(selection);
      if (!group) {
        continue;
      }
      const method = await pickMethod(group);
      if (method === BACK_VALUE) {
        continue;
      }
      return method;
    }
  };

  // No featured groups available → fall back to the original flat list so we
  // never strand the user behind an empty "More…" indirection.
  const runFlat = async (): Promise<PromptAuthChoiceResult> => {
    while (true) {
      const flatOptions: WizardSelectOption[] = moreGroups.map((group) =>
        groupToOption(group, configuredProvider),
      );
      if (skipOption) {
        flatOptions.push({ value: skipOption.value, label: skipOption.label });
      }
      const selection = await params.prompter.select({
        message: "Model/auth provider",
        options: flatOptions,
        searchable: true,
      });
      if (selection === "skip") {
        return "skip";
      }
      const group = groupById.get(selection);
      if (!group || group.options.length === 0) {
        await params.prompter.note(
          "No auth methods available for that provider.",
          "Model/auth choice",
        );
        continue;
      }
      const method = await pickMethod(group);
      if (method === BACK_VALUE) {
        continue;
      }
      return method;
    }
  };

  if (featuredGroups.length === 0) {
    return runFlat();
  }

  while (true) {
    const topTier: WizardSelectOption[] = featuredGroups.map((group) =>
      groupToOption(group, configuredProvider),
    );
    if (moreGroups.length > 0) {
      topTier.push({ value: MORE_VALUE, label: "More…" });
    }
    if (skipOption) {
      topTier.push({ value: skipOption.value, label: skipOption.label });
    }

    const topSelection = await params.prompter.select({
      message: "Model/auth provider",
      options: topTier,
    });

    if (topSelection === "skip") {
      return "skip";
    }
    if (topSelection === MORE_VALUE) {
      const more = await pickFromMore();
      if (more === BACK_VALUE) {
        continue;
      }
      return more;
    }
    const group = groupById.get(topSelection);
    if (!group || group.options.length === 0) {
      await params.prompter.note(
        "No auth methods available for that provider.",
        "Model/auth choice",
      );
      continue;
    }
    const method = await pickMethod(group);
    if (method === BACK_VALUE) {
      continue;
    }
    return method;
  }
}
