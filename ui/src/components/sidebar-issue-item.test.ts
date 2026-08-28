/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SidebarAttentionItem } from "./sidebar-attention-entries.ts";
import { renderSidebarIssueItem } from "./sidebar-issue-item.ts";

const item: SidebarAttentionItem = {
  type: "attention",
  category: "automations",
  dismissal: null,
  requiresAction: true,
  kind: "cronFailed",
  severity: "error",
  icon: "clock",
  label: "Nightly backup",
  detail: "Failed now",
  action: { kind: "navigate", routeId: "cron" },
  signature: "backup",
};

describe("renderSidebarIssueItem", () => {
  const container = document.createElement("div");

  afterEach(() => {
    render(null, container);
  });

  it("renders a dismiss control only when the producer supplies the action", () => {
    const shared = {
      basePath: "",
      onNavigate: vi.fn(),
      onOpen: vi.fn(),
    };
    render(renderSidebarIssueItem(item, shared), container);
    expect(container.querySelector(".sidebar-issues-panel__dismiss")).toBeNull();

    const onDismiss = vi.fn();
    render(renderSidebarIssueItem(item, { ...shared, onDismiss }), container);
    container.querySelector<HTMLButtonElement>(".sidebar-issues-panel__dismiss")?.click();
    expect(onDismiss).toHaveBeenCalledOnce();
  });
});
