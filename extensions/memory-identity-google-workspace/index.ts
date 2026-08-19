import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { resolveConfiguredSecretInputString } from "openclaw/plugin-sdk/secret-input-runtime";
import { createGoogleWorkspaceEnterpriseIdentityProvider } from "./src/adapter.js";

export default definePluginEntry({
  id: "memory-identity-google-workspace",
  name: "Google Workspace Memory Identity",
  description: "Verified Google Workspace authority for scoped memory access",
  register(api) {
    api.registerEnterpriseIdentityProvider(
      createGoogleWorkspaceEnterpriseIdentityProvider(api.pluginConfig, {
        resolveDirectoryServiceAccount: async (value) =>
          (
            await resolveConfiguredSecretInputString({
              config: api.config,
              env: process.env,
              value,
              path: "plugins.entries.memory-identity-google-workspace.config.directoryServiceAccount",
            })
          ).value,
        resolveClientSecret: async (value) =>
          (
            await resolveConfiguredSecretInputString({
              config: api.config,
              env: process.env,
              value,
              path: "plugins.entries.memory-identity-google-workspace.config.clientSecret",
            })
          ).value,
      }),
    );
  },
});
