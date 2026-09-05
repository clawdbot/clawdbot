import { getRuntimeConfig } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { isOpenAIGptLiveModel } from "./realtime-quicksilver.js";

export function resolveConfiguredLiveQuicksilverModel(): string | undefined {
  const realtime = getRuntimeConfig().talk?.realtime;
  const directModel = realtime?.model?.trim();
  if (isOpenAIGptLiveModel(directModel)) {
    return directModel;
  }
  const providerId = realtime?.provider?.trim().toLowerCase();
  const providerEntries = Object.entries(realtime?.providers ?? {});
  const providerConfig = providerId
    ? providerEntries.find(([id]) => id.trim().toLowerCase() === providerId)?.[1]
    : providerEntries.length === 1
      ? providerEntries[0]?.[1]
      : undefined;
  const providerModel = providerConfig?.model;
  const normalizedProviderModel =
    typeof providerModel === "string" ? providerModel.trim() : undefined;
  return isOpenAIGptLiveModel(normalizedProviderModel) ? normalizedProviderModel : undefined;
}
