/** Resolves preferred provider auth choices from config and plugin metadata. */
import { resolveLegacyOnboardAuthChoice } from "../commands/auth-choice-legacy.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveManifestProviderAuthChoice } from "./provider-auth-choices.js";

export async function resolvePreferredProviderForAuthChoice(params: {
  choice: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  includeUntrustedWorkspacePlugins?: boolean;
}): Promise<string | undefined> {
  const choice =
    resolveLegacyOnboardAuthChoice(params.choice, { env: params.env }).authChoice ?? params.choice;
  const manifestResolved = resolveManifestProviderAuthChoice(choice, params);
  if (manifestResolved) {
    return manifestResolved.providerId;
  }

  const { resolveProviderPluginChoice, resolvePluginProviders } =
    await import("./provider-auth-choice.runtime.js");
  const providers = resolvePluginProviders({
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
    mode: "setup",
    includeUntrustedWorkspacePlugins: params.includeUntrustedWorkspacePlugins,
  });
  const pluginResolved = resolveProviderPluginChoice({
    providers,
    choice,
  });
  if (pluginResolved) {
    return pluginResolved.provider.id;
  }

  if (choice === "custom-api-key") {
    return "custom";
  }
  return undefined;
}
