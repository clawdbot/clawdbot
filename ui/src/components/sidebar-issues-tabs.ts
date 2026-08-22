import { t } from "../i18n/index.ts";

export const ISSUE_TABS = ["all", "approvals", "automations", "system"] as const;
export type IssueTab = (typeof ISSUE_TABS)[number];

const TAB_LABEL_KEYS = {
  all: "attention.tabs.all",
  approvals: "attention.tabs.approvals",
  automations: "attention.tabs.automations",
  system: "attention.tabs.system",
} as const;

export function issueTabLabel(tab: IssueTab): string {
  return t(TAB_LABEL_KEYS[tab]);
}

export function nextIssueTab(tab: IssueTab, key: string): IssueTab | null {
  const index = ISSUE_TABS.indexOf(tab);
  if (key === "Home") {
    return ISSUE_TABS[0];
  }
  if (key === "End") {
    return ISSUE_TABS.at(-1) ?? null;
  }
  const offset = key === "ArrowLeft" ? -1 : key === "ArrowRight" ? 1 : 0;
  return offset === 0
    ? null
    : (ISSUE_TABS[(index + offset + ISSUE_TABS.length) % ISSUE_TABS.length] ?? null);
}
