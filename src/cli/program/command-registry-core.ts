// Core command registry that lazily imports command groups based on parsed argv.
import type { Command } from "commander";
import { resolveCliArgvInvocation } from "../argv-invocation.js";
import { shouldRegisterPrimaryCommandOnly } from "../command-registration-policy.js";
import {
  buildCommandGroupEntries,
  type CommandGroupDescriptorSpec,
} from "./command-group-descriptors.js";
import type { ProgramContext } from "./context.js";
import {
  getCoreCliCommandDescriptors,
  getCoreCliCommandNamesCore,
} from "./core-command-descriptors.js";
import {
  registerCommandGroupByName,
  registerCommandGroups,
  type CommandGroupEntry,
} from "./register-command-groups.js";

const coreEntrySpecs: readonly CommandGroupDescriptorSpec<[ctx: ProgramContext]>[] = [
  [
    ["setup", "crestodian"],
    async (program) => (await import("./register.setup.js")).registerSetupCommand(program),
  ],
  [
    ["onboard"],
    async (program) => (await import("./register.onboard.js")).registerOnboardCommand(program),
  ],
  [
    ["configure"],
    async (program) => (await import("./register.configure.js")).registerConfigureCommand(program),
  ],
  [["config"], async (program) => (await import("../config-cli.js")).registerConfigCli(program)],
  [["claws"], async (program) => (await import("../claws-cli.js")).registerClawsCli(program)],
  [
    ["backup"],
    async (program) => (await import("./register.backup.js")).registerBackupCommand(program),
  ],
  [
    ["database"],
    async (program) => (await import("./register.database.js")).registerDatabaseCommand(program),
  ],
  [
    ["migrate"],
    async (program) => (await import("./register.migrate.js")).registerMigrateCommand(program),
  ],
  [
    ["audit"],
    async (program) => (await import("./register.audit.js")).registerAuditCommand(program),
  ],
  [
    ["doctor", "triage", "dashboard", "reset", "uninstall"],
    async (program) =>
      (await import("./register.maintenance.js")).registerMaintenanceCommands(program),
  ],
  [
    ["message"],
    async (program, ctx) =>
      (await import("./register.message.js")).registerMessageCommands(program, ctx),
  ],
  [["mcp"], async (program) => (await import("../mcp-cli.js")).registerMcpCli(program)],
  [
    ["transcripts"],
    async (program) => (await import("./register.transcripts.js")).registerTranscriptsCli(program),
  ],
  [
    ["agent"],
    async (program, ctx) =>
      (await import("./register.agent-turn.js")).registerAgentTurnCommand(program, {
        agentChannelOptions: ctx.agentChannelOptions,
      }),
  ],
  [
    ["agents"],
    async (program) => (await import("./register.agent.js")).registerAgentsCommands(program),
  ],
  [
    ["status", "health", "sessions", "tasks"],
    async (program) =>
      (await import("./register.status-health-sessions.js")).registerStatusHealthSessionsCommands(
        program,
      ),
  ],
];

function resolveCoreCommandGroups(ctx: ProgramContext): CommandGroupEntry[] {
  const descriptors = getCoreCliCommandDescriptors();
  const visibleCommandNames = new Set(descriptors.map((descriptor) => descriptor.name));
  const visibleEntrySpecs = coreEntrySpecs.filter(([commandNames]) =>
    commandNames.every((name) => visibleCommandNames.has(name)),
  );
  // Descriptor metadata and import specs stay separate so help can stay cheap.
  return buildCommandGroupEntries(descriptors, visibleEntrySpecs, ctx);
}

export function getCoreCliCommandNames(): string[] {
  return getCoreCliCommandNamesCore();
}

export async function registerCoreCliByName(
  program: Command,
  ctx: ProgramContext,
  name: string,
): Promise<boolean> {
  return registerCommandGroupByName(program, resolveCoreCommandGroups(ctx), name);
}

export function registerCoreCliCommands(program: Command, ctx: ProgramContext, argv: string[]) {
  const { primary } = resolveCliArgvInvocation(argv);
  registerCommandGroups(program, resolveCoreCommandGroups(ctx), {
    eager: false,
    primary,
    registerPrimaryOnly: Boolean(primary && shouldRegisterPrimaryCommandOnly(argv)),
  });
}
