/**
 * Runtime access-group resolution for channel ingress.
 *
 * Preserves symbolic access-group entries until dynamic membership facts are available.
 */
import {
  normalizeStringEntries,
  uniqueStrings,
} from "@openclaw/normalization-core/string-normalization";
import { parseAccessGroupAllowFromEntry } from "../allow-from.js";
import type { ChannelIngressAdapter, ResolveChannelMessageIngressParams } from "./runtime-types.js";
import type { AccessGroupMembershipFact, ChannelIngressChannelId } from "./types.js";

function accessGroupNames(entries: readonly (string | number)[]): string[] {
  return uniqueStrings(
    entries
      .map((entry) => parseAccessGroupAllowFromEntry(String(entry)))
      .filter((entry): entry is string => entry != null),
  );
}

/**
 * Lists every access-group name referenced by grouped allowFrom entry arrays.
 */
export function allReferencedAccessGroupNames(
  entries: Array<readonly (string | number)[]>,
): string[] {
  return uniqueStrings(entries.flatMap((entryGroup) => accessGroupNames(entryGroup)));
}

/**
 * Normalizes direct sender entries while preserving access-group references for runtime lookup.
 */
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
  // Direct entries need adapter normalization for the current channel/account; access-group
  // entries stay symbolic until membership facts are resolved.
  const normalized = await params.adapter.normalizeEntries({
    entries: directEntries,
    context: params.context,
    accountId: params.accountId,
  });
  return uniqueStrings([
    ...accessGroupEntries,
    ...normalized.matchable.map((entry) => entry.value),
  ]);
}

/**
 * Resolves dynamic access-group membership facts for referenced runtime access groups.
 */
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
    // Static message.senders groups are expanded during allowlist normalization; runtime
    // membership hooks only evaluate dynamic/non-sender access-group types.
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
