import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { resolveConfiguredSecretInputString } from "openclaw/plugin-sdk/secret-input-runtime";
import { createOktaEnterpriseIdentityProvider } from "./src/adapter.js";

export default definePluginEntry({
  id: "memory-identity-okta",
  name: "Okta Memory Identity",
  description: "Verified Okta custom-authorization-server authority for scoped memory access",
  register(api) {
    api.registerEnterpriseIdentityProvider(
      createOktaEnterpriseIdentityProvider(api.pluginConfig, {
        resolveClientSecret: async (value) =>
          (
            await resolveConfiguredSecretInputString({
              config: api.config,
              env: process.env,
              value,
              path: "plugins.entries.memory-identity-okta.config.clientSecret",
            })
          ).value,
      }),
    );
  },
});
