import { Option, type Command } from "commander";
import { createLazyImportLoader } from "../shared/lazy-promise.js";
import { normalizeWindowsArgv } from "./windows-argv.js";

type ChannelSetupCliOptionsModule = typeof import("../channels/plugins/cli-add-options.js");
type ChannelSetupFlagArity = "boolean" | "value" | "conflict";

export type ChannelSetupCliOption = {
  flags: string;
  negatedFlags?: string;
  description: string;
  defaultValue?: boolean | string;
};

const CHANNEL_ADD_SHARED_BOOLEAN_OPTIONS = new Set(["--help", "-h"]);
const CHANNEL_ADD_SHARED_VALUE_OPTIONS = new Set(["--channel", "--account", "--name"]);
const CHANNEL_ADD_SHARED_VALUE_OPTION_PREFIXES = ["--channel=", "--account=", "--name="];

const channelSetupCliOptionsLoader = createLazyImportLoader<ChannelSetupCliOptionsModule>(
  () => import("../channels/plugins/cli-add-options.js"),
);

export function loadChannelSetupCliOptions(): Promise<ChannelSetupCliOptionsModule> {
  return channelSetupCliOptionsLoader.load();
}

export function getChannelSetupOptionSwitches(flags: string): string[] {
  const option = new Option(flags);
  return [option.short, option.long].filter((flag): flag is string => Boolean(flag));
}

function resolveChannelSetupFlagArity(flags: string): Exclude<ChannelSetupFlagArity, "conflict"> {
  return /<[^>]+>|\[[^\]]+\]/u.test(flags) ? "value" : "boolean";
}

function buildChannelSetupFlagArityMap(
  options: readonly ChannelSetupCliOption[],
): Map<string, ChannelSetupFlagArity> {
  const arityBySwitch = new Map<string, ChannelSetupFlagArity>();
  const addSwitch = (flag: string, arity: Exclude<ChannelSetupFlagArity, "conflict">) => {
    const existing = arityBySwitch.get(flag);
    arityBySwitch.set(flag, existing === undefined || existing === arity ? arity : "conflict");
  };
  for (const option of options) {
    const arity = resolveChannelSetupFlagArity(option.flags);
    for (const flag of getChannelSetupOptionSwitches(option.flags)) {
      addSwitch(flag, arity);
    }
    if (option.negatedFlags) {
      for (const flag of getChannelSetupOptionSwitches(option.negatedFlags)) {
        addSwitch(flag, "boolean");
      }
    }
  }
  return arityBySwitch;
}

export async function resolveChannelsAddChannelFromArgv(
  argv: string[],
): Promise<string | undefined> {
  const normalizedArgv = normalizeWindowsArgv(argv);
  const addIndex = normalizedArgv.findIndex(
    (arg, index) => arg === "add" && normalizedArgv[index - 1] === "channels",
  );
  if (addIndex === -1) {
    return undefined;
  }
  const args = normalizedArgv.slice(addIndex + 1);
  let explicitChannel: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg || arg === "--") {
      break;
    }
    if (arg === "--channel") {
      const value = args[index + 1]?.trim();
      explicitChannel = value || explicitChannel;
      index += 1;
      continue;
    }
    if (arg.startsWith("--channel=")) {
      const value = arg.slice("--channel=".length).trim();
      explicitChannel = value || explicitChannel;
    }
  }
  if (explicitChannel) {
    return explicitChannel;
  }

  let channelFlagArities: Map<string, ChannelSetupFlagArity> | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg || arg === "--") {
      break;
    }
    if (CHANNEL_ADD_SHARED_VALUE_OPTIONS.has(arg)) {
      index += 1;
      continue;
    }
    if (CHANNEL_ADD_SHARED_VALUE_OPTION_PREFIXES.some((prefix) => arg.startsWith(prefix))) {
      continue;
    }
    if (CHANNEL_ADD_SHARED_BOOLEAN_OPTIONS.has(arg)) {
      continue;
    }
    if (arg.startsWith("-")) {
      // Shipped `channels add` accepted channel flags before a positional id by registering every
      // channel option. Lazily inspect serialized all-channel metadata for arity only; actual
      // option registration remains scoped to the selected channel.
      if (!channelFlagArities) {
        const { resolveChannelSetupCliOptionMetadata } = await loadChannelSetupCliOptions();
        const { optionCandidates } = resolveChannelSetupCliOptionMetadata(undefined, {
          includeAll: true,
        });
        channelFlagArities = buildChannelSetupFlagArityMap(optionCandidates);
      }
      const equalsIndex = arg.indexOf("=");
      const optionSwitch = equalsIndex === -1 ? arg : arg.slice(0, equalsIndex);
      const arity = channelFlagArities.get(optionSwitch);
      if (!arity || arity === "conflict") {
        return undefined;
      }
      if (equalsIndex === -1 && arity === "value") {
        index += 1;
      }
      continue;
    }
    return arg;
  }
  return undefined;
}

export function resolveChannelsAddOptions(
  channelArg: string | undefined,
  opts: Record<string, unknown>,
  command?: Pick<Command, "getOptionValueSource">,
): Record<string, unknown> {
  const forwardedOpts = command
    ? Object.fromEntries(
        Object.entries(opts).filter(([key]) => command.getOptionValueSource(key) === "cli"),
      )
    : opts;
  return {
    ...forwardedOpts,
    channel: forwardedOpts.channel ?? channelArg,
  };
}
