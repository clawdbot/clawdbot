import { definePluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";

export default definePluginEntry({
  id: "vault",
  name: "Vault",
  description: "HashiCorp Vault SecretRef provider integration.",
  register(api: OpenClawPluginApi) {
    api.registerCli(
      async ({ program, config }) => {
        const { registerVaultCommands } = await import("./src/cli.js");
        registerVaultCommands({ program, config });
      },
      {
        descriptors: [
          {
            name: "vault",
            description: "Manage the Vault SecretRef provider integration",
            hasSubcommands: true,
          },
        ],
      },
    );
  },
});
