import type { Command } from "commander";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";

/**
 * Registers the `openclaw ag-ui` CLI command group (device management).
 * Called from registerFull() in index.ts.
 */
export function registerAguiCli(api: OpenClawPluginApi): void {
  api.registerCli(
    ({ program }: { program: Command }) => {
      const agui = program.command("ag-ui").description("AG-UI channel commands");

      agui
        .command("devices")
        .description("List approved devices")
        .action(async () => {
          const devices = await (
            api.runtime.channel.pairing.readAllowFromStore as unknown as (arg: {
              channel: string;
            }) => Promise<string[]>
          )({ channel: "ag-ui" });
          if (devices.length === 0) {
            console.log("No approved devices.");
            return;
          }
          console.log("Approved devices:");
          for (const deviceId of devices) {
            console.log(`  ${deviceId}`);
          }
        });
    },
    { commands: ["ag-ui"] },
  );
}
