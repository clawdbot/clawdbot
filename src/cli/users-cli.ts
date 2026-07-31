// Minimal gateway CLI commands for durable user profile administration.
import type { Command } from "commander";
import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import { callGatewayFromCli, type GatewayRpcOpts } from "./gateway-rpc.js";
import { applyParentDefaultHelpAction } from "./program/parent-default-help.js";

type UsersCliOpts = GatewayRpcOpts & { to?: string };

const DEFAULT_USERS_TIMEOUT_MS = 10_000;

function addUsersGatewayOptions(command: Command) {
  return command
    .option("--url <url>", "Gateway WebSocket URL (defaults to gateway.remote.url when configured)")
    .option("--token <token>", "Gateway token (if required)")
    .option("--timeout <ms>", "Timeout in ms", String(DEFAULT_USERS_TIMEOUT_MS))
    .option("--json", "Output JSON", false);
}

type UsersListResult = {
  profiles?: Array<{ id?: string; displayName?: string | null; emails?: string[] }>;
};

function writeUsersList(result: unknown, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  const profiles = (result as UsersListResult).profiles ?? [];
  for (const profile of profiles) {
    process.stdout.write(
      `${sanitizeTerminalText(profile.id ?? "")}\t${sanitizeTerminalText(profile.displayName ?? "")}\t${sanitizeTerminalText((profile.emails ?? []).join(","))}\n`,
    );
  }
}

export function registerUsersCli(program: Command) {
  const users = program
    .command("users")
    .description("Manage durable user profiles and email aliases");

  addUsersGatewayOptions(
    users
      .command("list")
      .description("List durable user profiles")
      .action(async (opts: UsersCliOpts) => {
        const result = await callGatewayFromCli(
          "users.list",
          opts,
          {},
          { scopes: ["operator.read"] },
        );
        writeUsersList(result, opts.json === true);
      }),
  );

  addUsersGatewayOptions(
    users
      .command("link-email <email>")
      .description("Link an email alias to a user profile")
      .requiredOption("--to <profileId>", "Target profile id")
      .action(async (email: string, opts: UsersCliOpts) => {
        const result = await callGatewayFromCli(
          "users.linkEmail",
          opts,
          { email, targetProfileId: opts.to },
          { scopes: ["operator.admin"] },
        );
        if (opts.json) {
          process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        }
      }),
  );

  applyParentDefaultHelpAction(users);
}

export const testApi = { writeUsersList };
