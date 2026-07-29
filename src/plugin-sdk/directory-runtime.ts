/** Shared directory listing helpers for plugins that derive users/groups from config maps. */
export type { DirectoryConfigParams } from "../channels/plugins/directory-types.js";
export type {
  ChannelDirectoryEntry,
  ChannelDirectoryEntryKind,
} from "../channels/plugins/types.public.js";
export type { ReadOnlyInspectedAccount } from "../channels/read-only-account-inspect.js";
export {
  createChannelDirectoryAdapter,
  createEmptyChannelDirectoryAdapter,
  emptyChannelDirectoryList,
  nullChannelDirectorySelf,
} from "../channels/plugins/directory-adapters.js";
export {
  applyDirectoryQueryAndLimit,
  collectNormalizedDirectoryIds,
  createInspectedDirectoryEntriesLister,
  createResolvedDirectoryEntriesLister,
  listDirectoryEntriesFromSources,
  listDirectoryGroupEntriesFromMapKeys,
  listDirectoryGroupEntriesFromMapKeysAndAllowFrom,
  listInspectedDirectoryEntriesFromSources,
  listResolvedDirectoryEntriesFromSources,
  listResolvedDirectoryGroupEntriesFromMapKeys,
  listResolvedDirectoryUserEntriesFromAllowFrom,
  listDirectoryUserEntriesFromAllowFrom,
  listDirectoryUserEntriesFromAllowFromAndMapKeys,
  toDirectoryEntries,
} from "../channels/plugins/directory-config-helpers.js";
export { createRuntimeDirectoryLiveAdapter } from "../channels/plugins/runtime-forwarders.js";
export { inspectReadOnlyChannelAccount } from "../channels/read-only-account-inspect.js";

// Resolves id and provider-specific allowlist entries against one directory snapshot.
export function resolveDirectoryAllowlistEntries<
  TParsed extends { id?: string },
  TLookup,
  TResult,
>(params: {
  entries: readonly string[];
  lookup: readonly TLookup[];
  parseInput: (input: string) => TParsed;
  findById: (lookup: readonly TLookup[], id: string) => TLookup | undefined;
  buildIdResolved: (params: { input: string; parsed: TParsed; match?: TLookup }) => TResult;
  resolveNonId: (params: {
    input: string;
    parsed: TParsed;
    lookup: readonly TLookup[];
  }) => TResult | undefined;
  buildUnresolved: (input: string) => TResult;
}): TResult[] {
  return params.entries.map((input) => {
    const parsed = params.parseInput(input);
    if (parsed.id) {
      return params.buildIdResolved({
        input,
        parsed,
        match: params.findById(params.lookup, parsed.id),
      });
    }
    return (
      params.resolveNonId({ input, parsed, lookup: params.lookup }) ?? params.buildUnresolved(input)
    );
  });
}
