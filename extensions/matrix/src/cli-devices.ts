import type { Command } from "commander";
import { timestampMsToIsoString } from "openclaw/plugin-sdk/number-runtime";
import * as cli from "./cli-shared.js";
import { listMatrixOwnDevices, pruneMatrixStaleGatewayDevices } from "./matrix/actions/devices.js";

function printMatrixOwnDevices(
  devices: Array<{
    deviceId: string;
    displayName: string | null;
    lastSeenIp: string | null;
    lastSeenTs: number | null;
    current: boolean;
  }>,
): void {
  if (devices.length === 0) {
    console.log("Devices: none");
    return;
  }
  for (const device of devices) {
    const labels = [device.current ? "current" : null, device.displayName]
      .filter((label): label is string => Boolean(label))
      .map((label) => cli.formatMatrixCliText(label));
    console.log(
      `- ${cli.formatMatrixCliText(device.deviceId)}${labels.length ? ` (${labels.join(", ")})` : ""}`,
    );
    const lastSeenAt = timestampMsToIsoString(device.lastSeenTs);
    if (lastSeenAt) {
      cli.printTimestamp("  Last seen", lastSeenAt);
    }
    if (device.lastSeenIp) {
      console.log(`  Last IP: ${cli.formatMatrixCliText(device.lastSeenIp)}`);
    }
  }
}

export function registerMatrixDeviceCommands(root: Command): void {
  const devices = root.command("devices").description("Inspect and clean up Matrix devices");

  devices
    .command("list")
    .description("List server-side Matrix devices for this account")
    .option("--account <id>", "Account ID (for multi-account setups)")
    .option("--verbose", "Show detailed diagnostics")
    .option("--json", "Output as JSON")
    .action(async (options: { account?: string; verbose?: boolean; json?: boolean }) => {
      const { accountId, cfg } = cli.resolveMatrixCliAccountContext(options.account);
      await cli.runMatrixCliCommand({
        verbose: options.verbose === true,
        json: options.json === true,
        run: async () => await listMatrixOwnDevices({ accountId, cfg }),
        onText: (result) => {
          cli.printAccountLabel(accountId);
          printMatrixOwnDevices(result);
        },
        errorPrefix: "Device listing failed",
      });
    });

  devices
    .command("prune-stale")
    .description("Delete stale OpenClaw-managed devices for this account")
    .option("--account <id>", "Account ID (for multi-account setups)")
    .option("--verbose", "Show detailed diagnostics")
    .option("--json", "Output as JSON")
    .action(async (options: { account?: string; verbose?: boolean; json?: boolean }) => {
      const { accountId, cfg } = cli.resolveMatrixCliAccountContext(options.account);
      await cli.runMatrixCliCommand({
        verbose: options.verbose === true,
        json: options.json === true,
        run: async () => await pruneMatrixStaleGatewayDevices({ accountId, cfg }),
        onText: (result, verbose) => {
          cli.printAccountLabel(accountId);
          console.log(
            `Deleted stale OpenClaw devices: ${
              result.deletedDeviceIds.length
                ? result.deletedDeviceIds
                    .map((deviceId) => cli.formatMatrixCliText(deviceId))
                    .join(", ")
                : "none"
            }`,
          );
          console.log(`Current device: ${cli.formatMatrixCliText(result.currentDeviceId)}`);
          console.log(`Remaining devices: ${result.remainingDevices.length}`);
          if (verbose) {
            console.log("Devices before cleanup:");
            printMatrixOwnDevices(result.before);
            console.log("Devices after cleanup:");
            printMatrixOwnDevices(result.remainingDevices);
          }
        },
        errorPrefix: "Device cleanup failed",
      });
    });
}
