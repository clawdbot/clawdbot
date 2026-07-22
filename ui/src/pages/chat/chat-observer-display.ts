import { getSafeLocalStorage } from "../../local-storage.ts";

const OBSERVER_DISPLAY_STORAGE_KEY = "openclaw.chat.observerHud.display";

export type ChatObserverDisplayPreference = "card" | "pill" | "off";

export function loadChatObserverDisplayPreference(): ChatObserverDisplayPreference {
  try {
    const stored = getSafeLocalStorage()?.getItem(OBSERVER_DISPLAY_STORAGE_KEY);
    return stored === "card" || stored === "off" ? stored : "pill";
  } catch {
    return "pill";
  }
}

export function storeChatObserverDisplayPreference(
  preference: ChatObserverDisplayPreference,
): void {
  try {
    getSafeLocalStorage()?.setItem(OBSERVER_DISPLAY_STORAGE_KEY, preference);
  } catch {
    // Privacy mode can make localStorage unavailable; the in-memory choice still works.
  }
}
