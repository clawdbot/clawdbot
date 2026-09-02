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
import { getSubCliEntriesCore, type SubCliDescriptor } from "./subcli-descriptors.js";

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

function defineImportedSubCliGroups(
  definitions: ReadonlyArray<
    readonly [readonly string[], () => Promise<Record<string, unknown>>, string]
  >,
) {
  return defineImportedProgramCommandGroupSpecs(
    definitions.map(([commandNames, loadModule, exportName]) => ({
      commandNames,
      loadModule,
      exportName,
    })),
  );
}

// Note for humans and agents:
// If you update the list of commands, also check whether they have subcommands
// and set the flag accordingly.
const entrySpecs: readonly CommandGroupDescriptorSpec<SubCliRegistrar>[] = [
  ...defineImportedSubCliGroups([
    [["acp"], () => import("../acp-cli.js"), "registerAcpCli"],
    [["gateway"], () => import("../gateway-cli.js"), "registerGatewayCli"],
    [["daemon"], () => import("../daemon-cli.js"), "registerDaemonCli"],
    [["logs"], () => import("../logs-cli.js"), "registerLogsCli"],
    [["system"], () => import("../system-cli.js"), "registerSystemCli"],
    [["models"], () => import("../models-cli.js"), "registerModelsCli"],
    [["promos"], () => import("../promos-cli.js"), "registerPromosCli"],
    [["telemetry"], () => import("../telemetry-cli.js"), "registerTelemetryCli"],
  ]),
  {
    commandNames: ["infer", "capability"],
    register: async (program, argv) => {
      const mod = await import("../capability-cli.js");
      await mod.registerCapabilityCli(program, argv);
    },
  },
  ...defineImportedSubCliGroups([
    // exec-approvals is a commander alias on the approvals command; the lazy
    // router only routes names listed here, so the alias must be owned too.
    [
      ["approvals", "exec-approvals"],
      () => import("../exec-approvals-cli.js"),
      "registerExecApprovalsCli",
    ],
    [["exec-policy"], () => import("../exec-policy-cli.js"), "registerExecPolicyCli"],
  ]),
  {
    commandNames: ["nodes"],
    register: async (program, argv) => {
      const mod = await import("../nodes-cli.js");
      await mod.registerNodesCli(program, argv);
    },
  },
  ...defineImportedSubCliGroups([
    [["devices"], () => import("../devices-cli.js"), "registerDevicesCli"],
    [["users"], () => import("../users-cli.js"), "registerUsersCli"],
    [["node"], () => import("../node-cli.js"), "registerNodeCli"],
    [["connect"], () => import("../connect-cli.js"), "registerConnectCli"],
    [["worker"], () => import("../worker-cli.js"), "registerWorkerCli"],
    [["sandbox"], () => import("../sandbox-cli.js"), "registerSandboxCli"],
    [["fleet"], () => import("../fleet-cli.js"), "registerFleetCli"],
    [["worktrees"], () => import("../worktrees-cli.js"), "registerWorktreesCli"],
    [["attach"], () => import("../attach-cli.js"), "registerAttachCli"],
    [["tui", "terminal", "chat"], () => import("../tui-cli.js"), "registerTuiCli"],
    [["resume"], () => import("../resume-cli.js"), "registerResumeCli"],
    // automations is a commander alias on the cron command; the lazy
    // router only routes names listed here, so the alias must be owned too.
    [["cron", "automations"], () => import("../cron-cli.js"), "registerCronCli"],
    [["dns"], () => import("../dns-cli.js"), "registerDnsCli"],
    [["docs"], () => import("../docs-cli.js"), "registerDocsCli"],
    [["qa"], loadPrivateQaCliModule, "registerQaLabCli"],
    [["proxy"], () => import("../proxy-cli.js"), "registerProxyCli"],
    [["hooks"], () => import("../hooks-cli.js"), "registerHooksCli"],
    [["webhooks"], () => import("../webhooks-cli.js"), "registerWebhooksCli"],
    [["qr"], () => import("../qr-cli.js"), "registerQrCli"],
    [["clawbot"], () => import("../clawbot-cli.js"), "registerClawbotCli"],
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
  ...defineImportedSubCliGroups([
    [["directory"], () => import("../directory-cli.js"), "registerDirectoryCli"],
    [["security"], () => import("../security-cli.js"), "registerSecurityCli"],
    [["secrets"], () => import("../secrets-cli.js"), "registerSecretsCli"],
    [["skills"], () => import("../skills-cli.js"), "registerSkillsCli"],
    [["update"], () => import("../update-cli.js"), "registerUpdateCli"],
  ]),
];

function resolveSubCliCommandGroups(
  argv: string[],
  context: SubCliRegistrationContext = {},
): CommandGroupEntry[] {
  const descriptors = getSubCliEntriesCore();
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
  return getSubCliEntriesCore();
}

export async function registerSubCliByNameCore(
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

export function registerSubCliCommandsCore(program: Command, argv: string[] = process.argv) {
  const { primary } = resolveCliArgvInvocation(argv);
  registerCommandGroups(program, resolveSubCliCommandGroups(argv), {
    eager: shouldEagerRegisterSubcommands(),
    primary,
    registerPrimaryOnly: Boolean(primary && shouldRegisterPrimarySubcommandOnly(argv)),
  });
}
