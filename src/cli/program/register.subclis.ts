// Sub-CLI registration: core subcommands plus lazily imported command groups.
import type { Command } from "commander";
import { resolveCliArgvInvocation } from "../argv-invocation.js";
import {
  shouldEagerRegisterSubcommands,
  shouldRegisterPrimarySubcommandOnly,
} from "../command-registration-policy.js";
import { buildCommandGroupEntries } from "./command-group-descriptors.js";
import { registerCommandGroupByName, registerCommandGroups } from "./register-command-groups.js";
import {
  registerSubCliByNameCore,
  registerSubCliCommandsCore,
  type SubCliRegistrationContext,
} from "./register.subclis-core.js";
import { getSubCliEntriesCore as getSubCliEntryDescriptors } from "./subcli-descriptors.js";

// Completion imports the core registry; keep its own lazy import outside that cycle.
const completionEntries = buildCommandGroupEntries(getSubCliEntryDescriptors(), [
  [
    ["completion"],
    async (program) => (await import("../completion-cli.js")).registerCompletionCli(program),
  ],
]);

/** Register one sub-CLI by name, including lazy command groups. */
export async function registerSubCliByName(
  program: Command,
  name: string,
  argv: string[] = process.argv,
  context: SubCliRegistrationContext = {},
): Promise<boolean> {
  if (await registerSubCliByNameCore(program, name, argv, context)) {
    return true;
  }
  return registerCommandGroupByName(program, completionEntries, name);
}

/** Register sub-CLI commands according to eager/lazy startup policy. */
export function registerSubCliCommands(program: Command, argv: string[] = process.argv) {
  registerSubCliCommandsCore(program, argv);
  const { primary } = resolveCliArgvInvocation(argv);
  registerCommandGroups(program, completionEntries, {
    eager: shouldEagerRegisterSubcommands(),
    primary,
    registerPrimaryOnly: Boolean(primary && shouldRegisterPrimarySubcommandOnly(argv)),
  });
}
