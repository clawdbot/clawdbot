import { describe, expect, it } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import { restSessionRow } from "../../lib/session-row-reveal.ts";
import {
  createGateway,
  createSessions,
  createSessionsHarness,
  mountSidebar,
} from "../app-sidebar.ts";
import "../../components/app-sidebar.ts";

const ACTION_COVER_PROPERTY = "--session-row-action-cover";

async function mountWithRows(rows: GatewaySessionRow[]) {
  const harness = createSessionsHarness("main", [rows[0]?.key ?? "agent:main:only"]);
  const { sidebar } = await mountSidebar(
    createGateway({} as GatewayBrowserClient),
    harness.sessions,
  );
  harness.publishList({
    result: {
      ts: 2,
      path: "",
      count: rows.length,
      defaults: { modelProvider: null, model: null, contextTokens: null },
      sessions: rows,
    } satisfies SessionsListResult,
  });
  await sidebar.updateComplete;
  return sidebar;
}

function rowFor(sidebar: Element, key: string): HTMLElement {
  const row = sidebar.querySelector<HTMLElement>(`[data-session-key="${key}"]`);
  expect(row).not.toBeNull();
  return row as HTMLElement;
}

describe("AppSidebar session management reveal", () => {
  it("ends every row with the endcap so state keeps one trailing rail", async () => {
    const sidebar = await mountWithRows([
      {
        key: "agent:main:parent",
        kind: "direct",
        label: "Plan release",
        updatedAt: 2,
        childSessions: ["agent:main:child"],
      },
      { key: "agent:main:solo", kind: "direct", label: "Ship release", updatedAt: 1 },
    ]);

    // The endcap holds the trailing edge by being last, not by any rule that
    // pins it, so the disclosure button has to precede it. Rendered after, it
    // pushes a parent's state inboard while childless rows keep the real edge --
    // the two rails an operator reads as a misaligned spinner.
    for (const key of ["agent:main:parent", "agent:main:solo"]) {
      const order = [...rowFor(sidebar, key).children].map(
        (child) => child.className.split(" ")[0],
      );
      expect(order.indexOf("sidebar-recent-session__aside")).toBe(order.length - 1);
      expect(order.indexOf("sidebar-recent-session__aside")).toBeGreaterThan(
        order.indexOf("sidebar-recent-session__link"),
      );
    }
  });

  it("holds the management layer revealed while the row menu is open", async () => {
    const sidebar = await mountWithRows([
      { key: "agent:main:one", kind: "direct", label: "One", updatedAt: 2 },
      { key: "agent:main:two", kind: "direct", label: "Two", updatedAt: 1 },
    ]);
    const row = rowFor(sidebar, "agent:main:one");
    expect(row.classList.contains("session-row-host--menu-open")).toBe(false);

    row.querySelector<HTMLButtonElement>("[data-session-menu]")?.click();
    await sidebar.updateComplete;

    expect(rowFor(sidebar, "agent:main:one").classList).toContain("session-row-host--menu-open");
    expect(rowFor(sidebar, "agent:main:two").classList).not.toContain(
      "session-row-host--menu-open",
    );
  });

  it("keeps the measured cover while the row menu holds the reveal open", () => {
    const host = document.createElement("div");
    host.className = "session-row-host session-row-host--menu-open";
    host.style.setProperty(ACTION_COVER_PROPERTY, "48px");
    document.body.append(host);
    try {
      // The menu is promoted to the top layer, so the pointer arriving on it
      // reads as leaving the row: no containment, hover, or focus guard sees it.
      // The fade rides on this value, and losing it would leave an opaque title
      // under the buttons the open menu is still holding visible.
      restSessionRow(host, null);
      expect(host.style.getPropertyValue(ACTION_COVER_PROPERTY)).toBe("48px");

      host.classList.remove("session-row-host--menu-open");
      restSessionRow(host, null);
      expect(host.style.getPropertyValue(ACTION_COVER_PROPERTY)).toBe("");
    } finally {
      host.remove();
    }
  });

  it("keeps every other row's fade while one row's menu is open", async () => {
    const sidebar = await mountWithRows([
      { key: "agent:main:one", kind: "direct", label: "One", updatedAt: 2 },
      { key: "agent:main:two", kind: "direct", label: "Two", updatedAt: 1 },
    ]);
    const sibling = () => rowFor(sidebar, "agent:main:two");
    sibling().dispatchEvent(new MouseEvent("mouseenter"));
    expect(sibling().style.getPropertyValue(ACTION_COVER_PROPERTY)).not.toBe("");
    sibling().dispatchEvent(new MouseEvent("mouseleave"));

    rowFor(sidebar, "agent:main:one")
      .querySelector<HTMLButtonElement>("[data-session-menu]")
      ?.click();
    await sidebar.updateComplete;

    // An open menu suppresses the traversal on other rows, never their fade.
    // CSS reveals Pin and More under the pointer whatever the menu is doing, so
    // a row that stopped publishing this measurement would hand those controls
    // unfaded title text to sit on.
    sibling().dispatchEvent(new MouseEvent("mouseenter"));
    expect(sibling().style.getPropertyValue(ACTION_COVER_PROPERTY)).not.toBe("");
  });

  it("measures how far the actions float over the row on entry", async () => {
    const sidebar = await mountWithRows([
      { key: "agent:main:one", kind: "direct", label: "One", updatedAt: 2 },
    ]);
    const row = rowFor(sidebar, "agent:main:one");
    expect(row.style.getPropertyValue(ACTION_COVER_PROPERTY)).toBe("");

    row.dispatchEvent(new MouseEvent("mouseenter"));
    expect(row.style.getPropertyValue(ACTION_COVER_PROPERTY)).not.toBe("");

    row.dispatchEvent(new MouseEvent("mouseleave"));
    expect(row.style.getPropertyValue(ACTION_COVER_PROPERTY)).toBe("");
  });

  it("gives catalog rows the same reveal measurement", async () => {
    const gateway = createGateway({} as GatewayBrowserClient);
    const { sidebar } = await mountSidebar(gateway, createSessions("main", ["agent:main:main"]));
    sidebar.sessionData.sessionCatalogs = [
      {
        id: "codex",
        label: "Codex",
        capabilities: { continueSession: true, archive: true },
        hosts: [
          {
            hostId: "gateway:local",
            label: "Local Codex",
            kind: "gateway",
            connected: true,
            sessions: [
              {
                threadId: "idle-thread",
                name: "Idle session",
                cwd: "/work/openclaw",
                status: "idle",
                archived: false,
                canContinue: true,
                canArchive: true,
              },
            ],
          },
        ],
      },
    ];
    sidebar.sessionData.requestSessionDataUpdate();
    await sidebar.updateComplete;

    const row = sidebar.querySelector<HTMLElement>('[data-session-key*="idle-thread"]');
    expect(row?.querySelector(".session-row-actions")).not.toBeNull();
    row?.dispatchEvent(new MouseEvent("mouseenter"));

    expect(row?.style.getPropertyValue(ACTION_COVER_PROPERTY)).not.toBe("");
  });
});
