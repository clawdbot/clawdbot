import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

export default definePluginEntry({
  id: "browser",
  name: "Browser",
  description: "Default browser tool plugin",
  register(api) {
    api.registerCli(
      async ({ program }) => {
        const { registerBrowserCli } = await import("./src/cli/browser-cli.js");
        registerBrowserCli(program);
      },
      { commands: ["browser"] },
    );
  },
});
