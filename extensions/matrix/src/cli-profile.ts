import type { Command } from "commander";
import * as cli from "./cli-shared.js";
import { applyMatrixProfileUpdate, type MatrixProfileUpdateResult } from "./profile-update.js";

export function registerMatrixProfileCommands(root: Command): void {
  const profile = root.command("profile").description("Manage Matrix bot profile");

  profile
    .command("set")
    .description("Update Matrix profile display name and/or avatar")
    .option("--account <id>", "Account ID (for multi-account setups)")
    .option("--name <name>", "Profile display name")
    .option("--avatar-url <url>", "Profile avatar URL (mxc:// or http(s) URL)")
    .option("--verbose", "Show detailed diagnostics")
    .option("--json", "Output as JSON")
    .action(
      async (options: {
        account?: string;
        name?: string;
        avatarUrl?: string;
        verbose?: boolean;
        json?: boolean;
      }) => {
        await cli.runMatrixCliCommand({
          verbose: options.verbose === true,
          json: options.json === true,
          run: async () =>
            await applyMatrixProfileUpdate({
              account: options.account,
              displayName: options.name,
              avatarUrl: options.avatarUrl,
            }),
          onText: (result: MatrixProfileUpdateResult) => {
            cli.printAccountLabel(result.accountId);
            console.log(`Config path: ${result.configPath}`);
            console.log(
              `Profile update: name ${result.profile.displayNameUpdated ? "updated" : "unchanged"}, avatar ${result.profile.avatarUpdated ? "updated" : "unchanged"}`,
            );
            if (result.profile.convertedAvatarFromHttp && result.avatarUrl) {
              console.log(
                `Avatar converted and saved as: ${cli.formatMatrixCliText(result.avatarUrl)}`,
              );
            }
          },
          errorPrefix: "Profile update failed",
        });
      },
    );
}
