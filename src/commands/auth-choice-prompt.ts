import type { AuthProfileStore } from "../agents/auth-profiles/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { WizardPrompter, WizardSelectOption } from "../wizard/prompts.js";
import { buildAuthChoiceGroups } from "./auth-choice-options.js";
import type { AuthChoiceGroup } from "./auth-choice-options.static.js";
import type { AuthChoice } from "./onboard-types.js";

const BACK_VALUE = "__back";
const MORE_VALUE = "__more";

type AuthChoiceOrBack = AuthChoice | typeof BACK_VALUE;

function isGroupFeatured(group: AuthChoiceGroup): boolean {
  return group.options.some((option) => option.onboardingFeatured);
}

function compareLabelsCaseInsensitive(a: string, b: string): number {
  return a.localeCompare(b, undefined, { sensitivity: "base" });
}

function compareGroupsByLabel(a: AuthChoiceGroup, b: AuthChoiceGroup): number {
  return compareLabelsCaseInsensitive(a.label, b.label);
}

function groupToOption(group: AuthChoiceGroup): WizardSelectOption {
  return { value: group.value, label: group.label, hint: group.hint };
}

export async function promptAuthChoiceGrouped(params: {
  prompter: WizardPrompter;
  store: AuthProfileStore;
  includeSkip: boolean;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<AuthChoice> {
  const { groups, skipOption } = buildAuthChoiceGroups(params);
  const availableGroups = groups.filter((group) => group.options.length > 0);
  const groupById = new Map(availableGroups.map((group) => [group.value, group] as const));
  const featuredGroups = availableGroups.filter(isGroupFeatured).toSorted(compareGroupsByLabel);
  const moreGroups = [...availableGroups].toSorted(compareGroupsByLabel);

  const pickMethod = async (group: AuthChoiceGroup): Promise<AuthChoiceOrBack> => {
    if (group.options.length === 1) {
      return group.options[0].value;
    }
    return (await params.prompter.select({
      message: `${group.label} auth method`,
      options: [...group.options, { value: BACK_VALUE, label: "Back" }],
    })) as AuthChoiceOrBack;
  };

  const pickFromMore = async (): Promise<AuthChoiceOrBack> => {
    while (true) {
      const options: WizardSelectOption[] = moreGroups.map(groupToOption);
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
  const runFlat = async (): Promise<AuthChoice> => {
    while (true) {
      const flatOptions: WizardSelectOption[] = moreGroups.map(groupToOption);
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
    const topTier: WizardSelectOption[] = featuredGroups.map(groupToOption);
    topTier.push({ value: MORE_VALUE, label: "More…" });
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
