import type { Command } from "commander";
import { applyParentDefaultHelpAction } from "./program/parent-default-help.js";

type DevicesRpcOpts = {
  url?: string;
  token?: string;
  password?: string;
  timeout?: string;
  json?: boolean;
  latest?: boolean;
  yes?: boolean;
  pending?: boolean;
  device?: string;
  role?: string;
  scope?: string[];
};

const DEFAULT_DEVICES_TIMEOUT_MS = 10_000;

const devicesCallOpts = (cmd: Command, defaults?: { timeoutMs?: number }) =>
  cmd
    .option("--url <url>", "Gateway WebSocket URL (defaults to gateway.remote.url when configured)")
    .option("--token <token>", "Gateway token (if required)")
    .option("--password <password>", "Gateway password (password auth)")
    .option(
      "--timeout <ms>",
      "Timeout in ms",
      String(defaults?.timeoutMs ?? DEFAULT_DEVICES_TIMEOUT_MS),
    )
    .option("--json", "Output JSON", false);

export function registerDevicesCli(program: Command) {
  const devices = program.command("devices").description("Device pairing and auth tokens");

  devicesCallOpts(
    devices
      .command("list")
      .description("List pending and paired devices")
      .action(async (opts: DevicesRpcOpts) => {
        const { runDevicesListCommand } = await import("./devices-cli.runtime.js");
        await runDevicesListCommand(opts);
      }),
  );

  devicesCallOpts(
    devices
      .command("remove")
      .description("Remove a paired device entry")
      .argument("<deviceId>", "Paired device id")
      .action(async (deviceId: string, opts: DevicesRpcOpts) => {
        const { runDevicesRemoveCommand } = await import("./devices-cli.runtime.js");
        await runDevicesRemoveCommand(deviceId, opts);
      }),
  );

  devicesCallOpts(
    devices
      .command("clear")
      .description("Clear paired devices from the gateway table")
      .option("--pending", "Also reject all pending pairing requests", false)
      .option("--yes", "Confirm destructive clear", false)
      .action(async (opts: DevicesRpcOpts) => {
        const { runDevicesClearCommand } = await import("./devices-cli.runtime.js");
        await runDevicesClearCommand(opts);
      }),
  );

  devicesCallOpts(
    devices
      .command("approve")
      .description("Approve a pending device pairing request")
      .argument("[requestId]", "Pending request id")
      .option("--latest", "Show the most recent pending request to approve explicitly", false)
      .action(async (requestId: string | undefined, opts: DevicesRpcOpts) => {
        const { runDevicesApproveCommand } = await import("./devices-cli.runtime.js");
        await runDevicesApproveCommand(requestId, opts);
      }),
  );

  devicesCallOpts(
    devices
      .command("reject")
      .description("Reject a pending device pairing request")
      .argument("<requestId>", "Pending request id")
      .action(async (requestId: string, opts: DevicesRpcOpts) => {
        const { runDevicesRejectCommand } = await import("./devices-cli.runtime.js");
        await runDevicesRejectCommand(requestId, opts);
      }),
  );

  devicesCallOpts(
    devices
      .command("rotate")
      .description("Rotate a device token for a role")
      .requiredOption("--device <id>", "Device id")
      .requiredOption("--role <role>", "Role name")
      .option("--scope <scope...>", "Scopes to attach to the token (repeatable)")
      .action(async (opts: DevicesRpcOpts) => {
        const { runDevicesRotateCommand } = await import("./devices-cli.runtime.js");
        await runDevicesRotateCommand(opts);
      }),
  );

  devicesCallOpts(
    devices
      .command("revoke")
      .description("Revoke a device token for a role")
      .requiredOption("--device <id>", "Device id")
      .requiredOption("--role <role>", "Role name")
      .action(async (opts: DevicesRpcOpts) => {
        const { runDevicesRevokeCommand } = await import("./devices-cli.runtime.js");
        await runDevicesRevokeCommand(opts);
      }),
  );

  applyParentDefaultHelpAction(devices);
}
