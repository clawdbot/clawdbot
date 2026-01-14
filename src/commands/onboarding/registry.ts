import { listChannelPlugins } from "../../channels/plugins/index.js";
import type { ChannelChoice } from "../onboard-types.js";
import type { ChannelOnboardingAdapter } from "./types.js";

const CHANNEL_ONBOARDING_ADAPTERS = () =>
  new Map<ChannelChoice, ChannelOnboardingAdapter>(
    listChannelPlugins()
      .map((plugin) =>
        plugin.onboarding
          ? ([plugin.id as ChannelChoice, plugin.onboarding] as const)
          : null,
      )
      .filter(
        (entry): entry is readonly [ChannelChoice, ChannelOnboardingAdapter] =>
          Boolean(entry),
      ),
  );

export function getChannelOnboardingAdapter(
  channel: ChannelChoice,
): ChannelOnboardingAdapter | undefined {
  return CHANNEL_ONBOARDING_ADAPTERS().get(channel);
}

export function listChannelOnboardingAdapters(): ChannelOnboardingAdapter[] {
  return Array.from(CHANNEL_ONBOARDING_ADAPTERS().values());
}

// Legacy aliases (pre-rename).
export const getProviderOnboardingAdapter = getChannelOnboardingAdapter;
export const listProviderOnboardingAdapters = listChannelOnboardingAdapters;
