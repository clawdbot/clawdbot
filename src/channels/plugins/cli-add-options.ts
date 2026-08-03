// Resolves plugin-owned `channels add` CLI options from bundled and catalog metadata.
import { Option } from "commander";
import { listBundledPackageChannelMetadata } from "../../plugins/bundled-package-channel-metadata.js";
import type {
  PluginPackageChannel,
  PluginPackageChannelCliOption,
} from "../../plugins/manifest.js";
import { listRawChannelPluginCatalogEntries } from "./catalog.js";

export type ChannelSetupCliOptionValueMetadata = {
  longFlag: string;
  valueType: NonNullable<PluginPackageChannelCliOption["valueType"]>;
};

// Commander rejects a second option whose long/short switch matches an existing
// one even when the value placeholder differs, so dedupe by switch identity or
// one plugin's `--url <server>` next to another's `--url <url>` would throw and
// break `channels add` registration entirely.
export function channelCliOptionSwitchKey(flags: string): string {
  const option = new Option(flags);
  return option.long ?? option.short ?? option.flags;
}

function compareChannels(left: PluginPackageChannel, right: PluginPackageChannel): number {
  const leftOrder = left.order ?? Number.MAX_SAFE_INTEGER;
  const rightOrder = right.order ?? Number.MAX_SAFE_INTEGER;
  return leftOrder === rightOrder
    ? (left.id ?? "").localeCompare(right.id ?? "")
    : leftOrder - rightOrder;
}

function channelSetupOptions(channel: PluginPackageChannel): PluginPackageChannelCliOption[] {
  // A migrating plugin may publish both surfaces so older cores keep working.
  // The modern contract owns parsing here, so only its options may register;
  // concatenating both would register flags that parseInput then rejects.
  if (channel.setup) {
    return channel.setup.fields.map((field) => field.cli);
  }
  return [...(channel.cliAddOptions ?? [])];
}

export function resolveChannelSetupCliOptionMetadata(
  channelId?: string,
  params: { includeAll?: boolean } = {},
) {
  const bundledChannels = listBundledPackageChannelMetadata().toSorted(compareChannels);
  const catalogChannels = listRawChannelPluginCatalogEntries({
    excludeWorkspace: true,
    excludeOrigins: ["bundled"],
  })
    .flatMap((entry) => (entry.channel ? [entry.channel] : []))
    .toSorted(compareChannels);
  const orderedChannels = [...bundledChannels, ...catalogChannels];
  const normalizedChannelId = channelId?.trim().toLowerCase();
  const selectedChannel = normalizedChannelId
    ? (orderedChannels.find((channel) => channel.id?.toLowerCase() === normalizedChannelId) ??
      orderedChannels.find((channel) =>
        channel.aliases?.some((alias) => alias.toLowerCase() === normalizedChannelId),
      ))
    : undefined;
  const channels = params.includeAll ? orderedChannels : selectedChannel ? [selectedChannel] : [];
  // Keep pre-dedupe candidates available to detect cross-channel flag-arity conflicts.
  const optionCandidates = channels.flatMap(channelSetupOptions);
  const seenSwitches = new Set<string>();
  const options = optionCandidates.filter((option) => {
    const key = channelCliOptionSwitchKey(option.flags);
    if (seenSwitches.has(key)) {
      return false;
    }
    seenSwitches.add(key);
    return true;
  });
  const valueMetadataByAttributeName = new Map<string, ChannelSetupCliOptionValueMetadata>();
  // Value coercion metadata is a legacy-options mechanism; modern contracts
  // type their fields, and their cliAddOptions never register above.
  if (selectedChannel && !selectedChannel.setup) {
    for (const option of selectedChannel.cliAddOptions ?? []) {
      if (!option.valueType) {
        continue;
      }
      const commanderOption = new Option(option.flags);
      valueMetadataByAttributeName.set(commanderOption.attributeName(), {
        longFlag: commanderOption.long ?? option.flags,
        valueType: option.valueType,
      });
    }
  }

  return { options, optionCandidates, selectedChannel, valueMetadataByAttributeName };
}
