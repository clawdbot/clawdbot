import { compareProviderAuthChoiceGroups } from "../plugins/provider-auth-choice-order.js";
import type { ProviderAuthChoiceMetadata } from "../plugins/provider-auth-choices.js";

export type SetupInferenceManualProvider = {
  /** Provider-auth choice id sent back to `openclaw.setup.activate`. */
  id: string;
  label: string;
  hint?: string;
};

export type SetupInferenceAuthOption = {
  /** Provider-auth choice id sent to `openclaw.setup.auth.start`. */
  id: string;
  label: string;
  hint?: string;
  groupLabel?: string;
  kind: "oauth" | "device-code";
  featured: boolean;
};

export function supportsSetupTextInference(
  scopes?: ProviderAuthChoiceMetadata["onboardingScopes"],
): boolean {
  return !scopes || scopes.includes("text-inference");
}

export function supportsSetupManualSecret(choice: ProviderAuthChoiceMetadata): boolean {
  return supportsSetupTextInference(choice.onboardingScopes) && choice.appGuidedSecret === true;
}

export function listSetupInferenceManualProviders(
  authChoices: readonly ProviderAuthChoiceMetadata[],
): SetupInferenceManualProvider[] {
  const choices = new Map<string, SetupInferenceManualProvider>();
  for (const choice of authChoices) {
    const id = choice.choiceId.trim();
    if (!id || choices.has(id) || !supportsSetupManualSecret(choice)) {
      continue;
    }
    choices.set(id, {
      id,
      label: choice.choiceLabel,
      ...(choice.choiceHint?.trim() ? { hint: choice.choiceHint.trim() } : {}),
    });
  }
  return [...choices.values()].toSorted(
    (a, b) => a.label.localeCompare(b.label, "en") || a.id.localeCompare(b.id, "en"),
  );
}

export function listSetupInferenceAuthOptions(
  authChoices: readonly ProviderAuthChoiceMetadata[],
): SetupInferenceAuthOption[] {
  const choices = new Map<
    string,
    { metadata: ProviderAuthChoiceMetadata; option: SetupInferenceAuthOption }
  >();
  for (const choice of authChoices) {
    const id = choice.choiceId.trim();
    if (
      !id ||
      choices.has(id) ||
      !supportsSetupTextInference(choice.onboardingScopes) ||
      choice.assistantVisibility === "manual-only" ||
      !choice.appGuidedAuth
    ) {
      continue;
    }
    choices.set(id, {
      metadata: choice,
      option: {
        id,
        label: choice.choiceLabel,
        ...(choice.choiceHint?.trim() ? { hint: choice.choiceHint.trim() } : {}),
        ...(choice.groupLabel?.trim() ? { groupLabel: choice.groupLabel.trim() } : {}),
        kind: choice.appGuidedAuth,
        featured: choice.onboardingFeatured === true,
      },
    });
  }
  return [...choices.values()]
    .toSorted(
      (a, b) =>
        Number(b.option.featured) - Number(a.option.featured) ||
        compareProviderAuthChoiceGroups(
          {
            id: a.metadata.groupId ?? a.metadata.providerId,
            label: a.metadata.groupLabel ?? a.metadata.choiceLabel,
          },
          {
            id: b.metadata.groupId ?? b.metadata.providerId,
            label: b.metadata.groupLabel ?? b.metadata.choiceLabel,
          },
        ) ||
        (a.metadata.assistantPriority ?? 0) - (b.metadata.assistantPriority ?? 0) ||
        a.option.label.localeCompare(b.option.label, "en") ||
        a.option.id.localeCompare(b.option.id, "en"),
    )
    .map(({ option }) => option);
}
