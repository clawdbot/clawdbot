import type { MentionInboxItem } from "../../../packages/gateway-protocol/src/index.js";
import type { NavigationRouteId } from "../app-navigation.ts";
import type { ScopeUpgradeState } from "../app/device-scope-upgrade-availability.ts";
import type { ExecApprovalRequest } from "../app/exec-approval.ts";
import type { CustodianAlert } from "./custodian-alert-contract.ts";
import type { IconName } from "./icons.ts";
import {
  resolveScopeUpgradeDismissal,
  type SidebarAttentionDismissal,
  type SidebarAttentionKind,
} from "./sidebar-attention-dismissals.ts";
import type { IssueTab } from "./sidebar-issues-tabs.ts";

type SidebarAttentionItemKind = Exclude<SidebarAttentionKind, "scopeUpgrade" | "updateAvailable">;

type SidebarInboxEntryBase<
  Category extends Exclude<IssueTab, "all">,
  Severity extends "error" | "warning" | "neutral" = "error" | "warning",
> = {
  category: Category;
  dismissal: SidebarAttentionDismissal | null;
  requiresAction: boolean;
  severity: Severity;
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
  | (SidebarInboxEntryBase<"mentions", "neutral"> & { type: "mention"; mention: MentionInboxItem })
  | (SidebarInboxEntryBase<"system"> & { type: "update" });

export function buildScopeUpgradeInboxEntry(params: {
  scopes: readonly string[] | undefined;
  state: ScopeUpgradeState;
}): Extract<SidebarInboxEntry, { type: "scopeUpgrade" }> | null {
  if (params.state.phase === "hidden") {
    return null;
  }
  return {
    type: "scopeUpgrade",
    category: "system",
    dismissal: resolveScopeUpgradeDismissal(params),
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
  mentions: readonly MentionInboxItem[];
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
  const mentions: SidebarInboxEntry[] = params.mentions
    .toSorted((left, right) => right.createdAt - left.createdAt || left.id.localeCompare(right.id))
    .map((mention) => ({
      type: "mention",
      mention,
      category: "mentions",
      dismissal: null,
      requiresAction: true,
      severity: "neutral",
    }));
  // Preserve the Inbox's action-first order while every tab reads one list.
  return [
    ...approvals,
    ...(params.update?.severity === "error" ? [params.update] : []),
    ...(params.scopeUpgrade ? [params.scopeUpgrade] : []),
    ...errors,
    ...(params.update?.severity === "warning" ? [params.update] : []),
    ...warnings,
    ...mentions,
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
    mentions: actionEntries.filter((entry) => entry.category === "mentions").length,
    automations: actionEntries.filter((entry) => entry.category === "automations").length,
    system: actionEntries.filter((entry) => entry.category === "system").length,
  };
}
