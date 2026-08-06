import { isReservedNonPluginCommandRoot } from "../cli/command-registration-policy.js";
import type { PluginCliDescriptorEntry } from "../plugins/cli-registry-loader.js";

export type CliCatalogPluginCommand = {
  readonly pluginId: string;
  readonly commandPath: readonly string[];
  readonly parentPath: readonly string[];
  readonly depth: number;
  readonly name: string;
  readonly descriptorName: string;
  readonly description: string;
  readonly hasSubcommands: boolean;
  readonly commandHints: readonly string[];
  readonly sourceKind: "plugin";
  readonly sourceId: string;
  readonly discoveryMode: "plugin-descriptor";
};

export function buildPluginCatalogCommands(
  entries: readonly PluginCliDescriptorEntry[],
): readonly CliCatalogPluginCommand[] {
  return entries.flatMap((entry) => {
    return entry.descriptors.flatMap((descriptor): CliCatalogPluginCommand[] => {
      const commandPath = [...entry.parentPath, descriptor.name];
      if (isReservedNonPluginCommandRoot(commandPath[0])) {
        return [];
      }
      return [
        {
          pluginId: entry.pluginId,
          commandPath,
          parentPath: entry.parentPath,
          depth: commandPath.length,
          name: descriptor.name,
          descriptorName: descriptor.name,
          description: descriptor.description,
          hasSubcommands: descriptor.hasSubcommands,
          commandHints: [commandPath.join(" ")],
          sourceKind: "plugin" as const,
          sourceId: `${entry.pluginId}:${commandPath.join(" ")}`,
          discoveryMode: "plugin-descriptor" as const,
        },
      ];
    });
  });
}
