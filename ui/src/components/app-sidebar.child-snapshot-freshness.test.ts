/* @vitest-environment jsdom */

import { describe, expect, it } from "vitest";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { SessionsListResult } from "../api/types.ts";
import {
  createGateway,
  createSessionsHarness,
  deferred,
  mountSidebar,
} from "../test-helpers/app-sidebar.ts";
import "../test-helpers/app-sidebar-suite.ts";
import { waitForFast } from "../test-helpers/wait-for.ts";
import "./app-sidebar.ts";

const parentKey = "agent:main:parent";
const childKey = "agent:worker:child";
const child = {
  key: childKey,
  spawnedBy: parentKey,
  kind: "direct" as const,
  label: "Original child",
  updatedAt: 1,
};

function result(sessions: SessionsListResult["sessions"]): SessionsListResult {
  return {
    ts: 10,
    path: "",
    count: sessions.length,
    defaults: { modelProvider: null, model: null, contextTokens: null },
    sessions,
  };
}

async function mountParent() {
  const harness = createSessionsHarness("main", [parentKey]);
  const { sidebar } = await mountSidebar(
    createGateway({} as GatewayBrowserClient),
    harness.sessions,
  );
  const publishParent = () =>
    harness.publishList({
      result: result([{ key: parentKey, kind: "direct", childSessions: [childKey] }]),
    });
  publishParent();
  await sidebar.updateComplete;
  const expand = () =>
    sidebar.querySelector<HTMLButtonElement>("[data-child-session-toggle]")!.click();
  return { harness, sidebar, publishParent, expand };
}

describe("sidebar child snapshot freshness", () => {
  it("clears a collapsed parent's cached child running indicator after a canonical refresh", async () => {
    const { harness, sidebar, expand } = await mountParent();
    harness.list.mockResolvedValueOnce(
      result([{ ...child, status: "running", hasActiveRun: true }]),
    );
    expand();
    await waitForFast(() =>
      expect(sidebar.querySelectorAll(".sidebar-recent-session--child")).toHaveLength(1),
    );
    expand();
    await sidebar.updateComplete;
    const toggle = () => sidebar.querySelector<HTMLButtonElement>("[data-child-session-toggle]")!;
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    expect(toggle().classList.contains("sidebar-child-session-toggle--running")).toBe(true);

    harness.publishList({
      result: result([
        { key: parentKey, kind: "direct", childSessions: [childKey], hasActiveSubagentRun: false },
      ]),
    });
    await sidebar.updateComplete;
    await sidebar.updateComplete;
    expect(toggle().classList.contains("sidebar-child-session-toggle--running")).toBe(false);
    expect(harness.list).toHaveBeenCalledTimes(1);
  });

  it("keeps loaded children visible while a canonical refresh revalidates them", async () => {
    const { harness, sidebar, publishParent, expand } = await mountParent();
    const sibling = { ...child, key: "agent:worker:sibling", label: "Removed sibling" };
    harness.list.mockResolvedValueOnce(result([child, sibling]));
    expand();
    await waitForFast(() =>
      expect(sidebar.querySelectorAll(".sidebar-recent-session--child")).toHaveLength(2),
    );

    const refresh = deferred<SessionsListResult>();
    harness.list.mockReturnValue(refresh.promise);
    publishParent();
    await waitForFast(() => expect(harness.list).toHaveBeenCalledTimes(2));
    await sidebar.updateComplete;
    expect(sidebar.querySelectorAll(".sidebar-recent-session--child")).toHaveLength(2);
    expect(sidebar.querySelector(".sidebar-session-tree__loading")).toBeNull();
    expect(sidebar.querySelector(`[data-session-key="${childKey}"]`)?.textContent).toContain(
      "Original child",
    );

    refresh.resolve(result([{ ...child, label: "Updated child", updatedAt: 20 }]));
    await waitForFast(() =>
      expect(sidebar.querySelector(`[data-session-key="${childKey}"]`)?.textContent).toContain(
        "Updated child",
      ),
    );
    expect(sidebar.querySelectorAll(`[data-session-key="${childKey}"]`)).toHaveLength(1);
    // A child the server no longer lists (deleted or archived) leaves with the refresh.
    expect(sidebar.querySelector(`[data-session-key="${sibling.key}"]`)).toBeNull();
  });

  it("ignores a child response from before a canonical refresh", async () => {
    const { harness, sidebar, publishParent, expand } = await mountParent();
    const stale = deferred<SessionsListResult>();
    const current = deferred<SessionsListResult>();
    harness.list.mockReturnValueOnce(stale.promise).mockReturnValueOnce(current.promise);
    const oldLoad = sidebar.sessionData.loadChildSessions(parentKey);
    expand();
    await sidebar.updateComplete;

    publishParent();
    const newLoad = sidebar.sessionData.loadChildSessions(parentKey);
    current.resolve(result([{ ...child, label: "Current child", updatedAt: 20 }]));
    await newLoad;
    await waitForFast(() => expect(sidebar.textContent).toContain("Current child"));

    stale.resolve(result([{ ...child, label: "Retired child", updatedAt: 10 }]));
    await oldLoad;
    await sidebar.updateComplete;
    expect(sidebar.querySelector(`[data-session-key="${childKey}"]`)?.textContent).toContain(
      "Current child",
    );
    expect(sidebar.textContent).not.toContain("Retired child");
    expect(sidebar.querySelector(".sidebar-session-tree__loading")).toBeNull();
    expect(harness.list).toHaveBeenCalledTimes(2);
  });
});
