import { compareProviderAuthChoiceGroups } from "../plugins/provider-auth-choice-order.js";
import type { ProviderAuthChoiceMetadata } from "../plugins/provider-auth-choices.js";
import type { ProviderInstallCatalogEntry } from "../plugins/provider-install-catalog.js";

export type SetupInferenceManualProvider = {
  /** Provider-auth choice id sent back to `openclaw.setup.activate`. */
  id: string;
  /** Canonical provider identity for clients with bundled brand artwork. */
  brandId?: string;
  /** Provider family shown above the specific credential method. */
  groupLabel?: string;
  label: string;
  hint?: string;
  icon?: string;
  website?: string;
};

export type SetupInferenceAuthOption = {
  /** Provider-auth choice id sent to `openclaw.setup.auth.start`. */
  id: string;
  /** Canonical provider identity for clients with bundled brand artwork. */
  brandId?: string;
  label: string;
  hint?: string;
  groupLabel?: string;
  icon?: string;
  website?: string;
  kind: "oauth" | "device-code" | "install" | "custom";
  featured: boolean;
};

export function listSetupInferenceInstallOptions(
  entries: readonly ProviderInstallCatalogEntry[],
  installedChoices: readonly ProviderAuthChoiceMetadata[],
): SetupInferenceAuthOption[] {
  const installed = new Set(installedChoices.map((choice) => choice.choiceId));
  const options = new Map<string, SetupInferenceAuthOption>();
  for (const entry of entries) {
    if (
      installed.has(entry.choiceId) ||
      options.has(entry.choiceId) ||
      !supportsSetupTextInference(entry.onboardingScopes)
    ) {
      continue;
    }
    options.set(entry.choiceId, {
      id: entry.choiceId,
      brandId: entry.providerId,
      label: entry.choiceLabel,
      ...(entry.choiceHint?.trim() ? { hint: entry.choiceHint.trim() } : {}),
      ...(entry.groupLabel?.trim() ? { groupLabel: entry.groupLabel.trim() } : {}),
      kind: "install",
      featured: false,
    });
  }
  return [...options.values()].toSorted(
    (a, b) =>
      Number(b.featured) - Number(a.featured) ||
      compareProviderAuthChoiceGroups(
        { id: a.brandId ?? a.id, label: a.groupLabel ?? a.label },
        { id: b.brandId ?? b.id, label: b.groupLabel ?? b.label },
      ) ||
      a.label.localeCompare(b.label, "en") ||
      a.id.localeCompare(b.id, "en"),
  );
}

export type SetupInferencePrepareOption = {
  /** Provider-auth choice id sent to `openclaw.setup.prepare.start`. */
  id: string;
  /** Canonical provider identity for clients with bundled brand artwork. */
  brandId?: string;
  label: string;
  hint?: string;
  actionLabel?: string;
  icon?: string;
  website?: string;
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
      brandId: choice.providerId,
      ...(choice.groupLabel?.trim() ? { groupLabel: choice.groupLabel.trim() } : {}),
      label: choice.choiceLabel,
      ...(choice.choiceHint?.trim() ? { hint: choice.choiceHint.trim() } : {}),
      ...(choice.icon ? { icon: choice.icon } : {}),
      ...(choice.website ? { website: choice.website } : {}),
    });
  }
  return [...choices.values()].toSorted(
    (a, b) =>
      compareProviderAuthChoiceGroups(
        { id: a.brandId ?? a.id, label: a.groupLabel ?? a.label },
        { id: b.brandId ?? b.id, label: b.groupLabel ?? b.label },
      ) ||
      a.label.localeCompare(b.label, "en") ||
      a.id.localeCompare(b.id, "en"),
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
      (!choice.appGuidedAuth &&
        (choice.appGuidedSecret === true || choice.appGuidedDiscovery === true))
    ) {
      continue;
    }
    choices.set(id, {
      metadata: choice,
      option: {
        id,
        brandId: choice.providerId,
        label: choice.choiceLabel,
        ...(choice.choiceHint?.trim() ? { hint: choice.choiceHint.trim() } : {}),
        ...(choice.groupLabel?.trim() ? { groupLabel: choice.groupLabel.trim() } : {}),
        ...(choice.icon ? { icon: choice.icon } : {}),
        ...(choice.website ? { website: choice.website } : {}),
        kind: choice.appGuidedAuth ?? "install",
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

export function listSetupInferenceEnableOptions(
  choices: readonly ProviderAuthChoiceMetadata[],
): SetupInferenceAuthOption[] {
  return choices
    .filter((choice) => supportsSetupTextInference(choice.onboardingScopes))
    .map((choice) => {
      const option: SetupInferenceAuthOption = {
        id: choice.choiceId,
        brandId: choice.providerId,
        label: choice.choiceLabel,
        kind: "install",
        featured: choice.onboardingFeatured === true,
      };
      const hint = choice.choiceHint?.trim();
      const groupLabel = choice.groupLabel?.trim();
      if (hint) {
        option.hint = hint;
      }
      if (groupLabel) {
        option.groupLabel = groupLabel;
      }
      if (choice.icon) {
        option.icon = choice.icon;
      }
      if (choice.website) {
        option.website = choice.website;
      }
      return option;
    })
    .toSorted(
      (a, b) =>
        Number(b.featured) - Number(a.featured) ||
        compareProviderAuthChoiceGroups(
          { id: a.brandId ?? a.id, label: a.groupLabel ?? a.label },
          { id: b.brandId ?? b.id, label: b.groupLabel ?? b.label },
        ) ||
        a.label.localeCompare(b.label, "en") ||
        a.id.localeCompare(b.id, "en"),
    );
}

export function listSetupInferencePrepareOptions(
  authChoices: readonly ProviderAuthChoiceMetadata[],
): SetupInferencePrepareOption[] {
  const choices = new Map<
    string,
    { metadata: ProviderAuthChoiceMetadata; option: SetupInferencePrepareOption }
  >();
  for (const choice of authChoices) {
    const id = choice.choiceId.trim();
    if (
      !id ||
      choices.has(id) ||
      !supportsSetupTextInference(choice.onboardingScopes) ||
      choice.appGuidedDiscovery !== true
    ) {
      continue;
    }
    choices.set(id, {
      metadata: choice,
      option: {
        id,
        brandId: choice.providerId,
        label: choice.choiceLabel,
        ...(choice.choiceHint?.trim() ? { hint: choice.choiceHint.trim() } : {}),
        ...(choice.appGuidedActionLabel?.trim()
          ? { actionLabel: choice.appGuidedActionLabel.trim() }
          : {}),
        ...(choice.icon ? { icon: choice.icon } : {}),
        ...(choice.website ? { website: choice.website } : {}),
      },
    });
  }
  return [...choices.values()]
    .toSorted(
      (a, b) =>
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
