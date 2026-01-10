import type { ProviderChoice } from "../onboard-types.js";
import type { ProviderOnboardingAdapter } from "./types.js";
import { discordOnboardingAdapter } from "./providers/discord.js";
import { imessageOnboardingAdapter } from "./providers/imessage.js";
import { msteamsOnboardingAdapter } from "./providers/msteams.js";
import { signalOnboardingAdapter } from "./providers/signal.js";
import { slackOnboardingAdapter } from "./providers/slack.js";
import { telegramOnboardingAdapter } from "./providers/telegram.js";
import { whatsappOnboardingAdapter } from "./providers/whatsapp.js";

const PROVIDER_ONBOARDING_ADAPTERS = new Map<
  ProviderChoice,
  ProviderOnboardingAdapter
>([
  [telegramOnboardingAdapter.provider, telegramOnboardingAdapter],
  [whatsappOnboardingAdapter.provider, whatsappOnboardingAdapter],
  [discordOnboardingAdapter.provider, discordOnboardingAdapter],
  [slackOnboardingAdapter.provider, slackOnboardingAdapter],
  [signalOnboardingAdapter.provider, signalOnboardingAdapter],
  [imessageOnboardingAdapter.provider, imessageOnboardingAdapter],
  [msteamsOnboardingAdapter.provider, msteamsOnboardingAdapter],
]);

export function getProviderOnboardingAdapter(
  provider: ProviderChoice,
): ProviderOnboardingAdapter | undefined {
  return PROVIDER_ONBOARDING_ADAPTERS.get(provider);
}

export function listProviderOnboardingAdapters(): ProviderOnboardingAdapter[] {
  return Array.from(PROVIDER_ONBOARDING_ADAPTERS.values());
}
