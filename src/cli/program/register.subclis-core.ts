import type { Command } from "commander";
import { resolveCliArgvInvocation } from "../argv-invocation.js";
import {
  shouldEagerRegisterSubcommands,
  shouldRegisterPrimarySubcommandOnly,
} from "../command-registration-policy.js";
import {
  buildCommandGroupEntries,
  defineImportedProgramCommandGroupSpecs,
  type CommandGroupDescriptorSpec,
} from "./command-group-descriptors.js";
import {
  registerCommandGroupByName,
  registerCommandGroups,
  type CommandGroupEntry,
} from "./register-command-groups.js";
import {
  getSubCliCommandsWithSubcommands,
  getSubCliEntries as getSubCliEntryDescriptors,
  type SubCliDescriptor,
} from "./subcli-descriptors.js";

export { getSubCliCommandsWithSubcommands };

type SubCliRegistrar = (program: Command) => Promise<void> | void;

async function registerSubCliWithPluginCommands(
  program: Command,
  registerSubCli: () => Promise<void>,
  pluginCliPosition: "before" | "after",
) {
  const { registerPluginCliCommandsFromValidatedConfig } = await import("../../plugins/cli.js");
  if (pluginCliPosition === "before") {
    await registerPluginCliCommandsFromValidatedConfig(program);
  }
  await registerSubCli();
  if (pluginCliPosition === "after") {
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
      commandNames: ["infer", "capability"],
      loadModule: () => import("../capability-cli.js"),
      exportName: "registerCapabilityCli",
    },
    {
      commandNames: ["approvals"],
      loadModule: () => import("../exec-approvals-cli.js"),
      exportName: "registerExecApprovalsCli",
    },
    {
      commandNames: ["exec-policy"],
      loadModule: () => import("../exec-policy-cli.js"),
      exportName: "registerExecPolicyCli",
    },
    {
      commandNames: ["nodes"],
      loadModule: () => import("../nodes-cli.js"),
      exportName: "registerNodesCli",
    },
    {
      commandNames: ["devices"],
      loadModule: () => import("../devices-cli.js"),
      exportName: "registerDevicesCli",
    },
    {
      commandNames: ["node"],
      loadModule: () => import("../node-cli.js"),
      exportName: "registerNodeCli",
    },
    {
      commandNames: ["sandbox"],
      loadModule: () => import("../sandbox-cli.js"),
      exportName: "registerSandboxCli",
    },
    {
      commandNames: ["tui"],
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
      loadModule: () => import("../../plugin-sdk/qa-lab.js"),
      exportName: "registerQaLabCli",
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
    register: async (program) => {
      await registerSubCliWithPluginCommands(
        program,
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
    register: async (program) => {
      await registerSubCliWithPluginCommands(
        program,
        async () => {
          const mod = await import("../plugins-cli.js");
          mod.registerPluginsCli(program);
        },
        "after",
      );
    },
  },
  ...defineImportedProgramCommandGroupSpecs([
    {
      commandNames: ["channels"],
      loadModule: () => import("../channels-cli.js"),
      exportName: "registerChannelsCli",
    },
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

function resolveSubCliCommandGroups(): CommandGroupEntry[] {
  return buildCommandGroupEntries(getSubCliEntryDescriptors(), entrySpecs, (register) => register);
}

export function getSubCliEntries(): ReadonlyArray<SubCliDescriptor> {
  return getSubCliEntryDescriptors();
}

export async function registerSubCliByName(program: Command, name: string): Promise<boolean> {
  return registerCommandGroupByName(program, resolveSubCliCommandGroups(), name);
}

export function registerSubCliCommands(program: Command, argv: string[] = process.argv) {
  const { primary } = resolveCliArgvInvocation(argv);
  registerCommandGroups(program, resolveSubCliCommandGroups(), {
    eager: shouldEagerRegisterSubcommands(),
    primary,
    registerPrimaryOnly: Boolean(primary && shouldRegisterPrimarySubcommandOnly(argv)),
  });
}
