// N-1 (legacy protocol) node feature filtering, kept out of the oversized
// node-command-policy.ts file.
import { getActivePluginGatewayNodePolicyRegistry } from "../plugins/runtime.js";
import {
  DEFAULT_DANGEROUS_NODE_COMMANDS,
  IOS_WATCH_RELAY_COMMANDS,
  PLATFORM_DEFAULTS,
  TALK_PTT_COMMANDS,
} from "./node-command-policy.js";

// Command ids the runtime already knows natively on some platform. Plugin-only
// surfaces (e.g. the Linux node plugin) must not strip these from a legacy node
// that declares them via its own native handler.
const BUILT_IN_NODE_COMMANDS = new Set<string>([
  ...Object.values(PLATFORM_DEFAULTS).flat(),
  ...DEFAULT_DANGEROUS_NODE_COMMANDS,
  ...TALK_PTT_COMMANDS,
  ...IOS_WATCH_RELAY_COMMANDS,
]);

export function filterLegacyNodeProtocolFeatures(params: {
  caps: readonly string[];
  commands: readonly string[];
  pluginSurfaces: readonly string[];
}): { caps: string[]; commands: string[] } {
  // N-1 nodes predate plugin-hosted surfaces. Preserve their durable pairing
  // declarations elsewhere, but hide unusable plugin features from this session.
  const registry = getActivePluginGatewayNodePolicyRegistry();
  if (!registry) {
    return { caps: [...params.caps], commands: [...params.commands] };
  }
  const pluginIds = new Set([
    ...registry.nodeHostCommands.map((entry) => entry.pluginId),
    ...registry.nodeInvokePolicies.map((entry) => entry.pluginId),
  ]);
  const pluginCaps = new Set([...params.pluginSurfaces, ...pluginIds]);
  const isPluginOnly = (command: string) => !BUILT_IN_NODE_COMMANDS.has(command);
  const pluginCommands = new Set([
    ...registry.nodeHostCommands.map((entry) => entry.command.command).filter(isPluginOnly),
    ...registry.nodeInvokePolicies.flatMap((entry) => entry.policy.commands).filter(isPluginOnly),
  ]);
  return {
    caps: params.caps.filter((cap) => !pluginCaps.has(cap)),
    commands: params.commands.filter((command) => !pluginCommands.has(command)),
  };
}
