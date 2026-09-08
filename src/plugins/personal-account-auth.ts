import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolvePluginMetadataSnapshot } from "./plugin-metadata-snapshot.js";
import { resolveManifestProviderAuthChoices } from "./provider-auth-choices.js";
import { resolveDiscoverableProviderOwnerPluginIds } from "./providers.js";

/** Personal auth is opt-in; discovery never enables, installs, or imports host credentials. */
export function listPersonalAccountAuthChoices(config: OpenClawConfig) {
  const metadataSnapshot = resolvePluginMetadataSnapshot({ config });
  const choices = resolveManifestProviderAuthChoices({
    config,
    metadataSnapshot,
    includeUntrustedWorkspacePlugins: false,
  }).filter((choice) => choice.personalAccount);
  const allowed = new Set(
    resolveDiscoverableProviderOwnerPluginIds({
      config,
      pluginIds: choices.map((choice) => choice.pluginId),
      registry: metadataSnapshot.index,
      manifestRegistry: metadataSnapshot.manifestRegistry,
      includeUntrustedWorkspacePlugins: false,
    }),
  );
  return choices.filter((choice) => allowed.has(choice.pluginId));
}

export async function resolvePersonalAccountAuthMethod(
  config: OpenClawConfig,
  providerId: string,
  methodId: string,
) {
  const choice = listPersonalAccountAuthChoices(config).find(
    (entry) => entry.providerId === providerId && entry.methodId === methodId,
  );
  if (!choice) {
    return undefined;
  }
  const { resolvePluginProvidersCore } = await import("./providers.runtime.js");
  const provider = resolvePluginProvidersCore({
    config,
    onlyPluginIds: [choice.pluginId],
    mode: "setup",
    cache: true,
    activate: false,
    includeUntrustedWorkspacePlugins: false,
  }).find((entry) => entry.pluginId === choice.pluginId && entry.id === providerId);
  return provider?.auth.find((method) => method.id === methodId);
}
