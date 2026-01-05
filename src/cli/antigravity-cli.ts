import type { Command } from "commander";
import {
  antigravityAddCommand,
  antigravityListCommand,
} from "../commands/antigravity.js";
import { defaultRuntime } from "../runtime.js";

export function registerAntigravityCli(program: Command) {
  const antigravity = program
    .command("antigravity")
    .description("Manage Google Antigravity accounts");

  antigravity
    .command("add")
    .description("Add a new Antigravity account")
    .action(async () => {
      try {
        await antigravityAddCommand(defaultRuntime);
      } catch (err) {
        defaultRuntime.error(String(err));
        defaultRuntime.exit(1);
      }
    });

  antigravity
    .command("list")
    .description("List Antigravity accounts")
    .action(async () => {
      try {
        await antigravityListCommand(defaultRuntime);
      } catch (err) {
        defaultRuntime.error(String(err));
        defaultRuntime.exit(1);
      }
    });
}
