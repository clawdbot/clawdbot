/**
 * Browser CLI metadata entry. It registers the `openclaw browser` command lazily
 * so command discovery does not load the full browser runtime.
 */
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

/** Plugin entry that contributes Browser CLI commands. */
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
