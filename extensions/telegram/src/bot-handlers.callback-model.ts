import { TelegramRetryableCallbackError } from "./bot-handlers.callback-router-controls.js";
import type { ProviderInfo } from "./model-buttons.js";

export async function retry<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    throw new TelegramRetryableCallbackError(error);
  }
}

export function providerInfos(
  providers: string[],
  byProvider: ReadonlyMap<string, ReadonlySet<string>>,
): ProviderInfo[] {
  return providers.map((provider) => ({
    id: provider,
    count: byProvider.get(provider)?.size ?? 0,
  }));
}

export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
