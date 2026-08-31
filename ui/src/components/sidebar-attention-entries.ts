import type { NavigationRouteId } from "../app-navigation.ts";
import type { ScopeUpgradeState } from "../app/device-scope-upgrade-availability.ts";
import type { ExecApprovalRequest } from "../app/exec-approval.ts";
import type { CustodianAlert } from "./custodian-alert-contract.ts";
import type { IconName } from "./icons.ts";
import type { IssueTab } from "./sidebar-issues-tabs.ts";

const SIDEBAR_ATTENTION_ITEM_KINDS = ["cronFailed", "cronOverdue", "modelAuthExpired"] as const;
type SidebarAttentionItemKind = (typeof SIDEBAR_ATTENTION_ITEM_KINDS)[number];

export const SIDEBAR_ATTENTION_DISMISSAL_KINDS = [
  ...SIDEBAR_ATTENTION_ITEM_KINDS,
  "scopeUpgrade",
  "updateAvailable",
] as const;
export type SidebarAttentionKind = (typeof SIDEBAR_ATTENTION_DISMISSAL_KINDS)[number];

export type SidebarAttentionDismissal = { kind: SidebarAttentionKind; signature: string };

type SidebarInboxEntryBase<Category extends Exclude<IssueTab, "all">> = {
  category: Category;
  dismissal: SidebarAttentionDismissal | null;
  requiresAction: boolean;
  severity: "error" | "warning";
};

export type SidebarAttentionItem = SidebarInboxEntryBase<"automations" | "system"> & {
  type: "attention";
  kind: SidebarAttentionItemKind;
  icon: IconName;
  label: string;
  detail: string;
  meta?: { context?: string; status: string; time: string };
  action:
    | { kind: "navigate"; routeId: NavigationRouteId }
    | { kind: "askCustodian"; alert: CustodianAlert };
  inlineAction?: { label: string; routeId: NavigationRouteId };
  signature: string;
};

export type SidebarInboxEntry =
  | SidebarAttentionItem
  | (SidebarInboxEntryBase<"approvals"> & {
      type: "approval";
      approval: ExecApprovalRequest;
    })
  | (SidebarInboxEntryBase<"system"> & {
      type: "scopeUpgrade";
      state: Exclude<ScopeUpgradeState, { phase: "hidden" }>;
    })
  | (SidebarInboxEntryBase<"system"> & { type: "update" });

export function buildScopeUpgradeInboxEntry(params: {
  scopes: readonly string[] | undefined;
  state: ScopeUpgradeState;
}): Extract<SidebarInboxEntry, { type: "scopeUpgrade" }> | null {
  if (params.state.phase === "hidden") {
    return null;
  }
  const dismissal =
    (params.state.phase === "guidance" || params.state.phase === "available") && params.scopes
      ? {
          kind: "scopeUpgrade" as const,
          // Manual repair and an actionable upgrade are distinct incidents.
          signature: JSON.stringify([params.state.phase, ...params.scopes.toSorted()]),
        }
      : null;
  return {
    type: "scopeUpgrade",
    category: "system",
    dismissal,
    requiresAction: true,
    severity:
      params.state.phase === "error" || params.state.phase === "rejected" ? "error" : "warning",
    state: params.state,
  };
}

export function buildUpdateInboxEntry(params: {
  canDismiss: boolean;
  dismissal: SidebarAttentionDismissal | null;
  forced: boolean;
  requiresAction: boolean;
  severity: "error" | "warning";
  visible: boolean;
}): Extract<SidebarInboxEntry, { type: "update" }> | null {
  if (!params.visible) {
    return null;
  }
  return {
    type: "update",
    category: "system",
    dismissal: params.canDismiss && !params.forced ? params.dismissal : null,
    requiresAction: params.requiresAction,
    severity: params.severity,
  };
}

export function buildSidebarInboxEntries(params: {
  approvals: readonly ExecApprovalRequest[];
  attention: readonly SidebarAttentionItem[];
  scopeUpgrade: Extract<SidebarInboxEntry, { type: "scopeUpgrade" }> | null;
  update: Extract<SidebarInboxEntry, { type: "update" }> | null;
}): SidebarInboxEntry[] {
  const approvals: SidebarInboxEntry[] = params.approvals.map((approval) => ({
    type: "approval",
    approval,
    category: "approvals",
    dismissal: null,
    requiresAction: true,
    severity: "warning",
  }));
  const errors = params.attention.filter((entry) => entry.severity === "error");
  const warnings = params.attention.filter((entry) => entry.severity === "warning");
  // Preserve the Inbox's action-first order while every tab reads one list.
  return [
    ...approvals,
    ...(params.update?.severity === "error" ? [params.update] : []),
    ...(params.scopeUpgrade ? [params.scopeUpgrade] : []),
    ...errors,
    ...(params.update?.severity === "warning" ? [params.update] : []),
    ...warnings,
  ];
}

export function sidebarInboxEntryMatchesTab(entry: SidebarInboxEntry, tab: IssueTab): boolean {
  return tab === "all" || entry.category === tab;
}

export function sidebarInboxTabCounts(
  entries: readonly SidebarInboxEntry[],
): Record<IssueTab, number> {
  const actionEntries = entries.filter((entry) => entry.requiresAction);
  return {
    all: actionEntries.length,
    approvals: actionEntries.filter((entry) => entry.category === "approvals").length,
    automations: actionEntries.filter((entry) => entry.category === "automations").length,
    system: actionEntries.filter((entry) => entry.category === "system").length,
  };
}
