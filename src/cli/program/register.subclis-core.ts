// Sub-CLI registry that lazily wires gateway, models, devices, plugins, and plugin commands.
import type { Command } from "commander";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import { resolveCliArgvInvocation } from "../argv-invocation.js";
import { resolveCliCommandPathPolicy } from "../command-path-policy.js";
import {
  shouldEagerRegisterSubcommands,
  shouldRegisterPrimarySubcommandOnly,
} from "../command-registration-policy.js";
import {
  buildCommandGroupEntries,
  defineImportedProgramCommandGroupSpecs,
  type CommandGroupDescriptorSpec,
} from "./command-group-descriptors.js";
import { removeCommandByName } from "./command-tree.js";
import { loadPrivateQaCliModule } from "./private-qa-cli.js";
import {
  registerCommandGroupByName,
  registerCommandGroups,
  type CommandGroupEntry,
} from "./register-command-groups.js";
import {
  getSubCliEntries as getSubCliEntryDescriptors,
  type SubCliDescriptor,
} from "./subcli-descriptors.js";

export type SubCliRegistrationContext = {
  purpose?: "runtime" | "completion";
};

type PluginCliModule = typeof import("../../plugins/cli.js");
type SubCliRegistrar = (
  program: Command,
  argv: string[],
  context: SubCliRegistrationContext,
) => Promise<void> | void;

const pluginCliLoader = createLazyImportLoader<PluginCliModule>(
  () => import("../../plugins/cli.js"),
);

function shouldRegisterGatewayRunOnly(name: string, argv: string[]): boolean {
  if (name !== "gateway") {
    return false;
  }
  const invocation = resolveCliArgvInvocation(argv);
  if (invocation.hasHelpOrVersion || invocation.commandPath[0] !== "gateway") {
    return false;
  }
  return invocation.commandPath.length === 1 || invocation.commandPath[1] === "run";
}

async function registerGatewayRunOnly(program: Command): Promise<void> {
  // Hot path for `gateway run`: avoid loading the full gateway command tree.
  const { addGatewayRunCommand } = await import("../gateway-cli/run-command.js");
  removeCommandByName(program, "gateway");
  const gateway = addGatewayRunCommand(
    program.command("gateway").description("Run, inspect, and query the WebSocket Gateway"),
  );
  addGatewayRunCommand(
    gateway.command("run").description("Run the WebSocket Gateway (foreground)"),
  );
}

async function registerSubCliWithPluginCommands(
  program: Command,
  argv: string[],
  registerSubCli: () => Promise<void>,
  pluginCliPosition: "before" | "after",
) {
  const invocation = resolveCliArgvInvocation(argv);
  const shouldRegisterPluginCommands =
    !invocation.hasHelpOrVersion &&
    resolveCliCommandPathPolicy(invocation.commandPath).loadPlugins !== "never";
  if (pluginCliPosition === "before" && shouldRegisterPluginCommands) {
    const { registerPluginCliCommandsFromValidatedConfig } = await pluginCliLoader.load();
    await registerPluginCliCommandsFromValidatedConfig(program);
  }
  await registerSubCli();
  if (pluginCliPosition === "after" && shouldRegisterPluginCommands) {
    const { registerPluginCliCommandsFromValidatedConfig } = await pluginCliLoader.load();
    await registerPluginCliCommandsFromValidatedConfig(program);
  }
}

// Note for humans and agents:
// If you update the list of commands, also check whether they have subcommands
// and set the flag accordingly.
const entrySpecs: readonly CommandGroupDescriptorSpec<SubCliRegistrar>[] = [
  ...defineImportedProgramCommandGroupSpecs([
    {
      commandNames: ["acp"],
      loadModule: () => import("../acp-cli.js"),
      exportName: "registerAcpCli",
    },
    {
      commandNames: ["gateway"],
      loadModule: () => import("../gateway-cli.js"),
      exportName: "registerGatewayCli",
    },
    {
      commandNames: ["daemon"],
      loadModule: () => import("../daemon-cli.js"),
      exportName: "registerDaemonCli",
    },
    {
      commandNames: ["logs"],
      loadModule: () => import("../logs-cli.js"),
      exportName: "registerLogsCli",
    },
    {
      commandNames: ["system"],
      loadModule: () => import("../system-cli.js"),
      exportName: "registerSystemCli",
    },
    {
      commandNames: ["models"],
      loadModule: () => import("../models-cli.js"),
      exportName: "registerModelsCli",
    },
    {
      commandNames: ["promos"],
      loadModule: () => import("../promos-cli.js"),
      exportName: "registerPromosCli",
    },
    {
      commandNames: ["infer", "capability"],
      loadModule: () => import("../capability-cli.js"),
      exportName: "registerCapabilityCli",
    },
    {
      // exec-approvals is a commander alias on the approvals command; the lazy
      // router only routes names listed here, so the alias must be owned too.
      commandNames: ["approvals", "exec-approvals"],
      loadModule: () => import("../exec-approvals-cli.js"),
      exportName: "registerExecApprovalsCli",
    },
    {
      commandNames: ["exec-policy"],
      loadModule: () => import("../exec-policy-cli.js"),
      exportName: "registerExecPolicyCli",
    },
  ]),
  {
    commandNames: ["nodes"],
    register: async (program, argv) => {
      const mod = await import("../nodes-cli.js");
      await mod.registerNodesCli(program, argv);
    },
  },
  ...defineImportedProgramCommandGroupSpecs([
    {
      commandNames: ["devices"],
      loadModule: () => import("../devices-cli.js"),
      exportName: "registerDevicesCli",
    },
    {
      commandNames: ["users"],
      loadModule: () => import("../users-cli.js"),
      exportName: "registerUsersCli",
    },
    {
      commandNames: ["node"],
      loadModule: () => import("../node-cli.js"),
      exportName: "registerNodeCli",
    },
    {
      commandNames: ["worker"],
      loadModule: () => import("../worker-cli.js"),
      exportName: "registerWorkerCli",
    },
    {
      commandNames: ["sandbox"],
      loadModule: () => import("../sandbox-cli.js"),
      exportName: "registerSandboxCli",
    },
    {
      commandNames: ["fleet"],
      loadModule: () => import("../fleet-cli.js"),
      exportName: "registerFleetCli",
    },
    {
      commandNames: ["worktrees"],
      loadModule: () => import("../worktrees-cli.js"),
      exportName: "registerWorktreesCli",
    },
    {
      commandNames: ["attach"],
      loadModule: () => import("../attach-cli.js"),
      exportName: "registerAttachCli",
    },
    {
      commandNames: ["tui", "terminal", "chat"],
      loadModule: () => import("../tui-cli.js"),
      exportName: "registerTuiCli",
    },
    {
      commandNames: ["cron"],
      loadModule: () => import("../cron-cli.js"),
      exportName: "registerCronCli",
    },
    {
      commandNames: ["dns"],
      loadModule: () => import("../dns-cli.js"),
      exportName: "registerDnsCli",
    },
    {
      commandNames: ["docs"],
      loadModule: () => import("../docs-cli.js"),
      exportName: "registerDocsCli",
    },
    {
      commandNames: ["qa"],
      loadModule: loadPrivateQaCliModule,
      exportName: "registerQaLabCli",
    },
    {
      commandNames: ["proxy"],
      loadModule: () => import("../proxy-cli.js"),
      exportName: "registerProxyCli",
    },
    {
      commandNames: ["hooks"],
      loadModule: () => import("../hooks-cli.js"),
      exportName: "registerHooksCli",
    },
    {
      commandNames: ["webhooks"],
      loadModule: () => import("../webhooks-cli.js"),
      exportName: "registerWebhooksCli",
    },
    {
      commandNames: ["qr"],
      loadModule: () => import("../qr-cli.js"),
      exportName: "registerQrCli",
    },
    {
      commandNames: ["clawbot"],
      loadModule: () => import("../clawbot-cli.js"),
      exportName: "registerClawbotCli",
    },
  ]),
  {
    commandNames: ["pairing"],
    register: async (program, argv) => {
      await registerSubCliWithPluginCommands(
        program,
        argv,
        async () => {
          const mod = await import("../pairing-cli.js");
          mod.registerPairingCli(program);
        },
        "before",
      );
    },
  },
  {
    commandNames: ["plugins"],
    register: async (program, argv) => {
      await registerSubCliWithPluginCommands(
        program,
        argv,
        async () => {
          const mod = await import("../plugins-cli.js");
          mod.registerPluginsCli(program);
        },
        "after",
      );
    },
  },
  {
    commandNames: ["channels"],
    register: async (program, argv, context) => {
      const mod = await import("../channels-cli.js");
      await mod.registerChannelsCli(program, argv, {
        includeSetupOptions: context.purpose === "completion",
      });
    },
  },
  ...defineImportedProgramCommandGroupSpecs([
    {
      commandNames: ["directory"],
      loadModule: () => import("../directory-cli.js"),
      exportName: "registerDirectoryCli",
    },
    {
      commandNames: ["security"],
      loadModule: () => import("../security-cli.js"),
      exportName: "registerSecurityCli",
    },
    {
      commandNames: ["secrets"],
      loadModule: () => import("../secrets-cli.js"),
      exportName: "registerSecretsCli",
    },
    {
      commandNames: ["skills"],
      loadModule: () => import("../skills-cli.js"),
      exportName: "registerSkillsCli",
    },
    {
      commandNames: ["update"],
      loadModule: () => import("../update-cli.js"),
      exportName: "registerUpdateCli",
    },
  ]),
];

function resolveSubCliCommandGroups(
  argv: string[],
  context: SubCliRegistrationContext = {},
): CommandGroupEntry[] {
  const descriptors = getSubCliEntryDescriptors();
  const descriptorNames = new Set(descriptors.map((descriptor) => descriptor.name));
  return buildCommandGroupEntries(
    descriptors,
    entrySpecs.filter((spec) => spec.commandNames.every((name) => descriptorNames.has(name))),
    (register) => async (program) => {
      await register(program, argv, context);
    },
  );
}

export function getSubCliEntries(): ReadonlyArray<SubCliDescriptor> {
  return getSubCliEntryDescriptors();
}

export async function registerSubCliByName(
  program: Command,
  name: string,
  argv: string[] = process.argv,
  context: SubCliRegistrationContext = {},
): Promise<boolean> {
  if (shouldRegisterGatewayRunOnly(name, argv)) {
    await registerGatewayRunOnly(program);
    return true;
  }
  return registerCommandGroupByName(program, resolveSubCliCommandGroups(argv, context), name);
}

export function registerSubCliCommands(program: Command, argv: string[] = process.argv) {
  const { primary } = resolveCliArgvInvocation(argv);
  registerCommandGroups(program, resolveSubCliCommandGroups(argv), {
    eager: shouldEagerRegisterSubcommands(),
    primary,
    registerPrimaryOnly: Boolean(primary && shouldRegisterPrimarySubcommandOnly(argv)),
  });
}
