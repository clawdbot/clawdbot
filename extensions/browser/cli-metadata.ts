/**
 * Browser CLI metadata entry. It registers the `openclaw browser` command lazily
 * so command discovery does not load the full browser runtime.
 */
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { isBrowserMachineOutput } from "./cli-output-mode.js";

/** Plugin entry that contributes Browser CLI commands. */
export default definePluginEntry({
  id: "browser",
  name: "Browser",
  description: "Default browser tool plugin",
  register(api) {
    api.registerCli(
      async ({ program }) => {
        const { registerBrowserCli } = await import("./src/cli/browser-cli.js");
        registerBrowserCli(program, process.argv, api.rootDir);
      },
      {
        commands: ["browser"],
        descriptors: [
          {
            name: "browser",
            description: "Manage OpenClaw's dedicated browser (Chrome/Chromium)",
            hasSubcommands: true,
            machineOutput: isBrowserMachineOutput,
          },
        ],
      },
    );
  },
});
