import { listProviderPlugins } from "../../providers/plugins/index.js";
import type { ProviderChoice } from "../onboard-types.js";
import type { ProviderOnboardingAdapter } from "./types.js";

const PROVIDER_ONBOARDING_ADAPTERS = () =>
  new Map<ProviderChoice, ProviderOnboardingAdapter>(
    listProviderPlugins()
      .map((plugin) =>
        plugin.onboarding
          ? ([plugin.id as ProviderChoice, plugin.onboarding] as const)
          : null,
      )
      .filter(
        (
          entry,
        ): entry is readonly [ProviderChoice, ProviderOnboardingAdapter] =>
          Boolean(entry),
      ),
  );

export function getProviderOnboardingAdapter(
  provider: ProviderChoice,
): ProviderOnboardingAdapter | undefined {
  return PROVIDER_ONBOARDING_ADAPTERS().get(provider);
}

export function listProviderOnboardingAdapters(): ProviderOnboardingAdapter[] {
  return Array.from(PROVIDER_ONBOARDING_ADAPTERS().values());
}
