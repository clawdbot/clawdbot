import type { ProviderThinkingProfile } from "openclaw/plugin-sdk/plugin-entry";

export function resolveThinkingProfile(): ProviderThinkingProfile {
  return { levels: [{ id: "off" }], defaultLevel: "off" };
}
