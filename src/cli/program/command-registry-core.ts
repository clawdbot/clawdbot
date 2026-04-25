import type { Command } from "commander";
import { resolveCliArgvInvocation } from "../argv-invocation.js";
import { shouldRegisterPrimaryCommandOnly } from "../command-registration-policy.js";
import {
  buildCommandGroupEntries,
  defineImportedCommandGroupSpec,
  defineImportedProgramCommandGroupSpecs,
  type CommandGroupDescriptorSpec,
} from "./command-group-descriptors.js";
import type { ProgramContext } from "./context.js";
import {
  getCoreCliCommandDescriptors,
  getCoreCliCommandNames as getCoreDescriptorNames,
  getCoreCliCommandsWithSubcommands,
} from "./core-command-descriptors.js";
import {
  registerCommandGroupByName,
  registerCommandGroups,
  type CommandGroupEntry,
} from "./register-command-groups.js";

export { getCoreCliCommandDescriptors, getCoreCliCommandsWithSubcommands };

type CommandRegisterParams = {
  program: Command;
  ctx: ProgramContext;
  argv: string[];
};

export type CommandRegistration = {
  id: string;
  register: (params: CommandRegisterParams) => void;
};

function withProgramOnlySpecs(
  specs: readonly CommandGroupDescriptorSpec<(program: Command) => Promise<void> | void>[],
): CommandGroupDescriptorSpec<(params: CommandRegisterParams) => Promise<void>>[] {
  return specs.map((spec) => ({
    commandNames: spec.commandNames,
    register: async ({ program }) => {
      await spec.register(program);
    },
  }));
}

// Note for humans and agents:
// If you update the list of commands, also check whether they have subcommands
// and set the flag accordingly.
const coreEntrySpecs: readonly CommandGroupDescriptorSpec<
  (params: CommandRegisterParams) => Promise<void> | void
>[] = [
  ...withProgramOnlySpecs(
    defineImportedProgramCommandGroupSpecs([
      {
        commandNames: ["crestodian"],
        loadModule: () => import("./register.crestodian.js"),
        exportName: "registerCrestodianCommand",
      },
      {
        commandNames: ["setup"],
        loadModule: () => import("./register.setup.js"),
        exportName: "registerSetupCommand",
      },
      {
        commandNames: ["onboard"],
        loadModule: () => import("./register.onboard.js"),
        exportName: "registerOnboardCommand",
      },
      {
        commandNames: ["configure"],
        loadModule: () => import("./register.configure.js"),
        exportName: "registerConfigureCommand",
      },
      {
        commandNames: ["config"],
        loadModule: () => import("../config-cli.js"),
        exportName: "registerConfigCli",
      },
      {
        commandNames: ["backup"],
        loadModule: () => import("./register.backup.js"),
        exportName: "registerBackupCommand",
      },
      {
        commandNames: ["doctor", "dashboard", "reset", "uninstall"],
        loadModule: () => import("./register.maintenance.js"),
        exportName: "registerMaintenanceCommands",
      },
    ]),
  ),
  defineImportedCommandGroupSpec(
    ["message"],
    () => import("./register.message.js"),
    (mod, { program, ctx }) => {
      mod.registerMessageCommands(program, ctx);
    },
  ),
  ...withProgramOnlySpecs(
    defineImportedProgramCommandGroupSpecs([
      {
        commandNames: ["mcp"],
        loadModule: () => import("../mcp-cli.js"),
        exportName: "registerMcpCli",
      },
    ]),
  ),
  defineImportedCommandGroupSpec(
    ["agent", "agents"],
    () => import("./register.agent.js"),
    (mod, { program, ctx }) => {
      mod.registerAgentCommands(program, {
        agentChannelOptions: ctx.agentChannelOptions,
      });
    },
  ),
  ...withProgramOnlySpecs(
    defineImportedProgramCommandGroupSpecs([
      {
        commandNames: ["status", "health", "sessions", "tasks"],
        loadModule: () => import("./register.status-health-sessions.js"),
        exportName: "registerStatusHealthSessionsCommands",
      },
    ]),
  ),
];

function resolveCoreCommandGroups(ctx: ProgramContext, argv: string[]): CommandGroupEntry[] {
  return buildCommandGroupEntries(
    getCoreCliCommandDescriptors(),
    coreEntrySpecs,
    (register) => async (program) => {
      await register({ program, ctx, argv });
    },
  );
}

export function getCoreCliCommandNames(): string[] {
  return getCoreDescriptorNames();
}

export async function registerCoreCliByName(
  program: Command,
  ctx: ProgramContext,
  name: string,
  argv: string[] = process.argv,
): Promise<boolean> {
  return registerCommandGroupByName(program, resolveCoreCommandGroups(ctx, argv), name);
}

export function registerCoreCliCommands(program: Command, ctx: ProgramContext, argv: string[]) {
  const { primary } = resolveCliArgvInvocation(argv);
  registerCommandGroups(program, resolveCoreCommandGroups(ctx, argv), {
    eager: false,
    primary,
    registerPrimaryOnly: Boolean(primary && shouldRegisterPrimaryCommandOnly(argv)),
  });
}
