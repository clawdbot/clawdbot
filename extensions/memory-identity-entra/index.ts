import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { resolveConfiguredSecretInputString } from "openclaw/plugin-sdk/secret-input-runtime";
import { createEntraEnterpriseIdentityProvider } from "./src/adapter.js";

export default definePluginEntry({
  id: "memory-identity-entra",
  name: "Microsoft Entra ID Memory Identity",
  description: "Verified Microsoft Entra ID authority for scoped memory access",
  register(api) {
    api.registerEnterpriseIdentityProvider(
      createEntraEnterpriseIdentityProvider(api.pluginConfig, {
        resolveClientSecret: async (value) =>
          (
            await resolveConfiguredSecretInputString({
              config: api.config,
              env: process.env,
              value,
              path: "plugins.entries.memory-identity-entra.config.clientSecret",
            })
          ).value,
      }),
    );
  },
});
