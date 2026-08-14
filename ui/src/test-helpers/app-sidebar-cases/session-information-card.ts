import { describe, expect, it } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import { SESSION_CARD_COLD_DELAY_MS } from "../../components/session-row-hover-card.ts";
import {
  createGateway,
  createSessions,
  createSessionsHarness,
  mountSidebar,
} from "../app-sidebar.ts";
import "../../components/app-sidebar.ts";

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

function cardHost(sidebar: Element, key: string): HTMLElement | null {
  return (
    sidebar
      .querySelector(`[data-session-key="${key}"]`)
      ?.closest<HTMLElement>("openclaw-tooltip.session-hover-tooltip") ?? null
  );
}

describe("AppSidebar session information card", () => {
  it("asks for a deliberate cold open beside the row it describes", async () => {
    const sidebar = await mountWithRows([
      { key: "agent:main:one", kind: "direct", label: "One", updatedAt: 2 },
    ]);
    const host = cardHost(sidebar, "agent:main:one");

    expect(host?.getAttribute("delay")).toBe(String(SESSION_CARD_COLD_DELAY_MS));
    expect(host?.getAttribute("placement")).toBe("right");
  });

  it("reveals the checkout the row could only abbreviate", async () => {
    const sidebar = await mountWithRows([
      {
        key: "agent:main:work",
        kind: "direct",
        label: "Work",
        updatedAt: 2,
        worktree: { id: "wt-1", branch: "feature/sidebar", repoRoot: "/Users/ada/code/openclaw" },
      },
    ]);
    const rows = [
      ...(cardHost(sidebar, "agent:main:work")?.querySelectorAll(".session-hover-card__row") ?? []),
    ].map((row) => (row.textContent ?? "").replace(/\s+/gu, " ").trim());

    expect(rows).toEqual(["Project /Users/ada/code/openclaw", "Branch feature/sidebar"]);
  });

  it("gives child rows no card of their own", async () => {
    const sidebar = await mountWithRows([
      {
        key: "agent:main:parent",
        kind: "direct",
        label: "Parent",
        updatedAt: 2,
        childSessions: ["agent:main:child"],
      },
    ]);
    const parent = cardHost(sidebar, "agent:main:parent");

    expect(parent?.querySelector(".session-hover-card")).not.toBeNull();
    expect(parent?.querySelectorAll(".session-hover-card")).toHaveLength(1);
  });

  it("stands the card down while the row menu owns the pointer", async () => {
    const sidebar = await mountWithRows([
      { key: "agent:main:one", kind: "direct", label: "One", updatedAt: 2 },
    ]);
    expect(cardHost(sidebar, "agent:main:one")?.hasAttribute("suppressed")).toBe(false);

    sidebar
      .querySelector<HTMLButtonElement>('[data-session-key="agent:main:one"] [data-session-menu]')
      ?.click();
    await sidebar.updateComplete;

    expect(cardHost(sidebar, "agent:main:one")?.hasAttribute("suppressed")).toBe(true);
  });

  it("gives a catalog session the same card", async () => {
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
                gitBranch: "main",
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

    const host = sidebar
      .querySelector('[data-session-key*="idle-thread"]')
      ?.closest("openclaw-tooltip.session-hover-tooltip");
    const rows = [...(host?.querySelectorAll(".session-hover-card__row") ?? [])].map((row) =>
      (row.textContent ?? "").replace(/\s+/gu, " ").trim(),
    );

    expect(rows).toEqual(["Project /work/openclaw", "Branch main"]);
  });
});
