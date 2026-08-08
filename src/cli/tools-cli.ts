import type { Command } from "commander";
import { registerCommandsCli } from "./catalog-cli.js";
import { applyParentDefaultHelpAction } from "./program/parent-default-help.js";

export function registerToolsCli(program: Command): void {
  const tools = program.command("tools").description("Inspect OpenClaw tool and command metadata");

  registerCommandsCli(tools);
  applyParentDefaultHelpAction(tools);
}
