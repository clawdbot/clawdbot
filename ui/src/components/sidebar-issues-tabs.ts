import { t } from "../i18n/index.ts";

export const ISSUE_TABS = ["all", "approvals", "mentions", "automations", "system"] as const;
export type IssueTab = (typeof ISSUE_TABS)[number];

const TAB_LABEL_KEYS = {
  all: "attention.tabs.all",
  approvals: "attention.tabs.approvals",
  mentions: "attention.tabs.mentions",
  automations: "attention.tabs.automations",
  system: "attention.tabs.system",
} as const;

export function issueTabLabel(tab: IssueTab): string {
  return t(TAB_LABEL_KEYS[tab]);
}
