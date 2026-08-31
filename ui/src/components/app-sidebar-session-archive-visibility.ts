import type { SessionCapability } from "../lib/sessions/index.ts";
import { normalizeAgentId } from "../lib/sessions/session-key.ts";
import type { SidebarSessionStatusFilter } from "./app-sidebar-session-types.ts";
import type { SessionDataController } from "./session-data-controller.ts";

export function projectSidebarArchiveVisibility(input: {
  sessionData: Pick<
    SessionDataController,
    "childSessionRowsByParent" | "sessionResultsByAgent" | "sessionsAgentId" | "sessionsResult"
  >;
  selectedAgentId: string;
  statusFilter: SidebarSessionStatusFilter;
  deletionState: SessionCapability["deletionState"];
  archiveVisibility: SessionCapability["archiveVisibility"];
}) {
  const isSessionHidden = (key: string) => {
    const visibility = input.archiveVisibility(key);
    return (
      input.deletionState(key, input.selectedAgentId) ||
      visibility === "pending" ||
      (input.statusFilter === "active" && visibility === "archived")
    );
  };
  const selectedAgentId = normalizeAgentId(input.selectedAgentId);
  const rows = (
    selectedAgentId === normalizeAgentId(input.sessionData.sessionsAgentId ?? "")
      ? (input.sessionData.sessionsResult?.sessions ?? [])
      : (input.sessionData.sessionResultsByAgent[selectedAgentId]?.sessions ?? [])
  ).filter((row) => !isSessionHidden(row.key));
  const childSessionRowsByParent = Object.fromEntries(
    Object.entries(input.sessionData.childSessionRowsByParent).map(([parentKey, childRows]) => [
      parentKey,
      childRows.filter((row) => !isSessionHidden(row.key)),
    ]),
  );
  return { childSessionRowsByParent, isSessionHidden, rows };
}
