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

const entrySpecs: readonly CommandGroupDescriptorSpec<
  [argv: string[], context: SubCliRegistrationContext]
>[] = [
  [["acp"], async (program) => (await import("../acp-cli.js")).registerAcpCli(program)],
  [["gateway"], async (program) => (await import("../gateway-cli.js")).registerGatewayCli(program)],
  [["daemon"], async (program) => (await import("../daemon-cli.js")).registerDaemonCli(program)],
  [["logs"], async (program) => (await import("../logs-cli.js")).registerLogsCli(program)],
  [["system"], async (program) => (await import("../system-cli.js")).registerSystemCli(program)],
  [["models"], async (program) => (await import("../models-cli.js")).registerModelsCli(program)],
  [["promos"], async (program) => (await import("../promos-cli.js")).registerPromosCli(program)],
  [
    ["telemetry"],
    async (program) => (await import("../telemetry-cli.js")).registerTelemetryCli(program),
  ],
  [
    ["infer", "capability"],
    async (program, argv) =>
      (await import("../capability-cli.js")).registerCapabilityCli(program, argv),
  ],
  // Aliases must belong to the same lazy group so either spelling replaces all placeholders.
  [
    ["approvals", "exec-approvals"],
    async (program) => (await import("../exec-approvals-cli.js")).registerExecApprovalsCli(program),
  ],
  [
    ["exec-policy"],
    async (program) => (await import("../exec-policy-cli.js")).registerExecPolicyCli(program),
  ],
  [
    ["nodes"],
    async (program, argv) => (await import("../nodes-cli.js")).registerNodesCli(program, argv),
  ],
  [["devices"], async (program) => (await import("../devices-cli.js")).registerDevicesCli(program)],
  [["users"], async (program) => (await import("../users-cli.js")).registerUsersCli(program)],
  [["node"], async (program) => (await import("../node-cli.js")).registerNodeCli(program)],
  [["connect"], async (program) => (await import("../connect-cli.js")).registerConnectCli(program)],
  [["worker"], async (program) => (await import("../worker-cli.js")).registerWorkerCli(program)],
  [["sandbox"], async (program) => (await import("../sandbox-cli.js")).registerSandboxCli(program)],
  [["fleet"], async (program) => (await import("../fleet-cli.js")).registerFleetCli(program)],
  [
    ["worktrees"],
    async (program) => (await import("../worktrees-cli.js")).registerWorktreesCli(program),
  ],
  [["attach"], async (program) => (await import("../attach-cli.js")).registerAttachCli(program)],
  [
    ["tui", "terminal", "chat"],
    async (program) => (await import("../tui-cli.js")).registerTuiCli(program),
  ],
  [["resume"], async (program) => (await import("../resume-cli.js")).registerResumeCli(program)],
  [
    ["cron", "automations"],
    async (program) => (await import("../cron-cli.js")).registerCronCli(program),
  ],
  [["dns"], async (program) => (await import("../dns-cli.js")).registerDnsCli(program)],
  [["docs"], async (program) => (await import("../docs-cli.js")).registerDocsCli(program)],
  [
    ["qa"],
    async (program) => {
      // This registrar comes from a source-checkout artifact, not a statically known module.
      const { registerQaLabCli } = await loadPrivateQaCliModule();
      if (typeof registerQaLabCli !== "function") {
        throw new Error("Missing program command registrar: registerQaLabCli");
      }
      await registerQaLabCli(program);
    },
  ],
  [["proxy"], async (program) => (await import("../proxy-cli.js")).registerProxyCli(program)],
  [["hooks"], async (program) => (await import("../hooks-cli.js")).registerHooksCli(program)],
  [
    ["webhooks"],
    async (program) => (await import("../webhooks-cli.js")).registerWebhooksCli(program),
  ],
  [["qr"], async (program) => (await import("../qr-cli.js")).registerQrCli(program)],
  [["clawbot"], async (program) => (await import("../clawbot-cli.js")).registerClawbotCli(program)],
  [
    ["pairing"],
    async (program, argv) => {
      // Pairing reads channel capabilities while registering, so initialize plugins first.
      await registerSubCliWithPluginCommands(
        program,
        argv,
        async () => (await import("../pairing-cli.js")).registerPairingCli(program),
        "before",
      );
    },
  ],
  [
    ["plugins"],
    async (program, argv) => {
      await registerSubCliWithPluginCommands(
        program,
        argv,
        async () => (await import("../plugins-cli.js")).registerPluginsCli(program),
        "after",
      );
    },
  ],
  [
    ["channels"],
    async (program, argv, context) =>
      (await import("../channels-cli.js")).registerChannelsCli(program, argv, {
        includeSetupOptions: context.purpose === "completion",
      }),
  ],
  [
    ["directory"],
    async (program) => (await import("../directory-cli.js")).registerDirectoryCli(program),
  ],
  [
    ["security"],
    async (program) => (await import("../security-cli.js")).registerSecurityCli(program),
  ],
  [["secrets"], async (program) => (await import("../secrets-cli.js")).registerSecretsCli(program)],
  [["skills"], async (program) => (await import("../skills-cli.js")).registerSkillsCli(program)],
  [["update"], async (program) => (await import("../update-cli.js")).registerUpdateCli(program)],
];

function resolveSubCliCommandGroups(
  argv: string[],
  context: SubCliRegistrationContext = {},
): CommandGroupEntry[] {
  const descriptors = getSubCliEntriesCore();
  const descriptorNames = new Set(descriptors.map((descriptor) => descriptor.name));
  return buildCommandGroupEntries(
    descriptors,
    entrySpecs.filter(([commandNames]) => commandNames.every((name) => descriptorNames.has(name))),
    argv,
    context,
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
