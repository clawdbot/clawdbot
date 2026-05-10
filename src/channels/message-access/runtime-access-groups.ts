import { normalizeStringEntries } from "../../shared/string-normalization.js";
import { parseAccessGroupAllowFromEntry } from "../allow-from.js";
import type { ChannelIngressAdapter, ResolveChannelMessageIngressParams } from "./runtime-types.js";
import type { AccessGroupMembershipFact, ChannelIngressChannelId } from "./types.js";

function uniqueValues<T extends string | number>(values: readonly T[]): T[] {
  return Array.from(new Set(values));
}

function accessGroupNames(entries: readonly (string | number)[]): string[] {
  return Array.from(
    new Set(
      entries
        .map((entry) => parseAccessGroupAllowFromEntry(String(entry)))
        .filter((entry): entry is string => entry != null),
    ),
  );
}

export function allReferencedAccessGroupNames(
  entries: Array<readonly (string | number)[]>,
): string[] {
  return Array.from(new Set(entries.flatMap((entryGroup) => accessGroupNames(entryGroup))));
}

export async function normalizeEffectiveEntries(params: {
  adapter: ChannelIngressAdapter;
  accountId: string;
  entries: readonly (string | number)[];
  context: "dm" | "group" | "route" | "command";
}): Promise<string[]> {
  const rawEntries = normalizeStringEntries(params.entries);
  const accessGroupEntries = rawEntries.filter(
    (entry) => parseAccessGroupAllowFromEntry(entry) != null,
  );
  const directEntries = rawEntries.filter((entry) => parseAccessGroupAllowFromEntry(entry) == null);
  if (directEntries.length === 0) {
    return accessGroupEntries;
  }
  const normalized = await params.adapter.normalizeEntries({
    entries: directEntries,
    context: params.context,
    accountId: params.accountId,
  });
  return uniqueValues([...accessGroupEntries, ...normalized.matchable.map((entry) => entry.value)]);
}

export async function resolveRuntimeAccessGroupMembershipFacts(params: {
  input: ResolveChannelMessageIngressParams;
  channelId: ChannelIngressChannelId;
  names: readonly string[];
}): Promise<AccessGroupMembershipFact[]> {
  if (!params.input.resolveAccessGroupMembership || params.names.length === 0) {
    return [];
  }
  const facts: AccessGroupMembershipFact[] = [];
  for (const name of params.names) {
    const group = params.input.accessGroups?.[name];
    if (!group || group.type === "message.senders") {
      continue;
    }
    try {
      const matched = await params.input.resolveAccessGroupMembership({
        name,
        group,
        channelId: params.channelId,
        accountId: params.input.accountId,
        subject: params.input.subject,
      });
      facts.push(
        matched
          ? {
              kind: "matched",
              groupName: name,
              source: "dynamic",
              matchedEntryIds: [`access-group:${name}`],
            }
          : {
              kind: "not-matched",
              groupName: name,
              source: "dynamic",
            },
      );
    } catch {
      facts.push({
        kind: "failed",
        groupName: name,
        source: "dynamic",
        reasonCode: "access_group_failed",
        diagnosticId: `access-group:${name}`,
      });
    }
  }
  return facts;
}
