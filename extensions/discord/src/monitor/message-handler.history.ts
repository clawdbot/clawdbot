// Discord plugin module owns sender provenance for its in-memory history window.
import type { ContextVisibilityMode } from "openclaw/plugin-sdk/config-contracts";
import type { HistoryEntry } from "openclaw/plugin-sdk/reply-history";
import { filterSupplementalContextItems } from "openclaw/plugin-sdk/security-runtime";
import type { DiscordSenderIdentity } from "./sender-identity.js";

type DiscordHistorySenderProvenance = Readonly<{
  id: string;
  name?: string;
  tag?: string;
  memberRoleIds: readonly string[];
}>;

export type DiscordHistoryEntry = HistoryEntry & {
  senderProvenance: DiscordHistorySenderProvenance;
};

export function createDiscordHistorySenderProvenance(params: {
  sender: Pick<DiscordSenderIdentity, "id" | "name" | "tag">;
  memberRoleIds: readonly string[];
}): DiscordHistorySenderProvenance {
  // Snapshot admission-time identity instead of later re-parsing an ambiguous display label.
  // Freezing keeps context filtering tied to the sender facts that produced the history entry.
  return Object.freeze({
    id: params.sender.id,
    name: params.sender.name,
    tag: params.sender.tag,
    memberRoleIds: Object.freeze([...params.memberRoleIds]),
  });
}

export function filterDiscordHistoryEntriesForContext(params: {
  entries: readonly DiscordHistoryEntry[];
  mode: ContextVisibilityMode;
  isSenderAllowed: (sender: DiscordHistorySenderProvenance) => boolean;
}): { entries: DiscordHistoryEntry[]; omitted: number } {
  if (params.mode === "all") {
    return { entries: [...params.entries], omitted: 0 };
  }
  const filtered = filterSupplementalContextItems({
    items: params.entries,
    mode: params.mode,
    kind: "history",
    isSenderAllowed: (entry) =>
      Boolean(entry.senderProvenance) && params.isSenderAllowed(entry.senderProvenance),
  });
  return { entries: filtered.items, omitted: filtered.omitted };
}
