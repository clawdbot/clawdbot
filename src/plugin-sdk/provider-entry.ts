import { definePluginEntry } from "./plugin-entry.js";
import type { ProviderPlugin } from "./provider-models.js";

type SingleProviderPluginEntryOptions = {
  id: string;
  name: string;
  description: string;
  provider: Omit<ProviderPlugin, "id">;
};

export function defineSingleProviderPluginEntry(options: SingleProviderPluginEntryOptions) {
  return definePluginEntry({
    id: options.id,
    name: options.name,
    description: options.description,
    register(api) {
      api.registerProvider({
        id: options.id,
        ...options.provider,
      });
    },
  });
}
