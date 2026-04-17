import { createCapturedPluginRegistration } from "../plugins/captured-registration.js";
import type { OpenClawPluginApi, ProviderPlugin } from "../plugins/types.js";

export { createCapturedPluginRegistration };

type RegistrablePlugin = {
  register(api: OpenClawPluginApi): void;
};

export async function registerSingleProviderPlugin(params: {
  register(api: OpenClawPluginApi): void;
}): Promise<ProviderPlugin> {
  const captured = createCapturedPluginRegistration();
  params.register(captured.api);
  const provider = captured.providers[0];
  if (!provider) {
    throw new Error("provider registration missing");
  }
  return provider;
}

export async function registerProviderPlugins(
  ...plugins: RegistrablePlugin[]
): Promise<ProviderPlugin[]> {
  const captured = createCapturedPluginRegistration();
  for (const plugin of plugins) {
    plugin.register(captured.api);
  }
  return captured.providers;
}

export function requireRegisteredProvider(providers: ProviderPlugin[], providerId: string) {
  const provider = providers.find((entry) => entry.id === providerId);
  if (!provider) {
    throw new Error(`provider ${providerId} missing`);
  }
  return provider;
}
