import { compareProviderAuthChoiceGroups } from "../plugins/provider-auth-choice-order.js";
import type { ProviderAuthChoiceMetadata } from "../plugins/provider-auth-choices.js";
import {
  listProviderAccessOptions,
  listProviderLoginOptions,
  supportsProviderAuthChoiceTextInference,
  type ProviderLoginOption,
} from "../plugins/provider-login-options.js";

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

export type SetupInferenceAuthOption = ProviderLoginOption & {
  kind: "oauth" | "device-code";
};

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
  return supportsProviderAuthChoiceTextInference(scopes);
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
  return listProviderLoginOptions(authChoices).filter(
    (option): option is SetupInferenceAuthOption =>
      option.kind === "oauth" || option.kind === "device-code",
  );
}

export function listSetupInferencePrepareOptions(
  authChoices: readonly ProviderAuthChoiceMetadata[],
): SetupInferencePrepareOption[] {
  return listProviderAccessOptions(authChoices).flatMap((option) => {
    if (option.mode !== "setup") {
      return [];
    }
    return [
      {
        id: option.id,
        ...(option.brandId ? { brandId: option.brandId } : {}),
        label: option.label,
        ...(option.hint ? { hint: option.hint } : {}),
        ...(option.actionLabel ? { actionLabel: option.actionLabel } : {}),
        ...(option.icon ? { icon: option.icon } : {}),
        ...(option.website ? { website: option.website } : {}),
      },
    ];
  });
}
