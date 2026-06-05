// Control UI module implements app last active session behavior.
import type { UiSettings } from "./storage.ts";

type LastActiveSessionHost = {
  settings: UiSettings;
  applySettings(next: UiSettings): void;
};

export function setLastActiveSessionKey(host: LastActiveSessionHost, next: string) {
  const trimmed = next.trim();
  if (!trimmed || host.settings.lastActiveSessionKey === trimmed) {
    return;
  }
  host.applySettings({ ...host.settings, lastActiveSessionKey: trimmed });
}
