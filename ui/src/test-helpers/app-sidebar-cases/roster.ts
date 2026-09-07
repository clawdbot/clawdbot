import { describe, expect, it, vi } from "vitest";
import type { AgentsListResult, GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import { loadSettings } from "../../app/settings.ts";
import { createGateway, createSessionsHarness, mountSidebar } from "../app-sidebar.ts";
import { createGatewayRequestMock, createTestGatewayClient } from "../gateway-client.ts";

const roster: AgentsListResult = {
  defaultId: "main",
  mainKey: "main",
  scope: "per-sender",
  agents: [
    { id: "main", name: "Harbor", identity: { emoji: "⚓" } },
    { id: "recent", name: "Scout" },
    { id: "working", name: "Forge" },
    { id: "system", name: "System helper", kind: "system" },
  ],
};

function session(agentId: string, updatedAt: number, extra: Partial<GatewaySessionRow> = {}) {
  return {
    key: `agent:${agentId}:main`,
    agentId,
    isMain: true,
    kind: "direct",
    updatedAt,
    ...extra,
  } satisfies GatewaySessionRow;
}

async function mountRoster(agents = roster, rows?: GatewaySessionRow[]) {
  const now = Date.now();
  const result: SessionsListResult = {
    ts: now,
    path: "",
    count: rows?.length ?? 4,
    defaults: { model: null, modelProvider: null, contextTokens: null },
    sessions: rows ?? [
      session("main", now - 180_000, { unread: true }),
      session("recent", now - 60_000),
      session("working", now - 300_000, {
        hasActiveRun: true,
        lastMessagePreview: "Preparing the project summary.",
      }),
      session("system", now, { hasActiveRun: true }),
    ],
  };
  const request = createGatewayRequestMock(async (method) => {
    if (method === "sessions.list") {
      return result;
    }
    if (method === "sessions.subscribe") {
      return { subscribed: true };
    }
    throw new Error(`Unexpected RPC: ${method}`);
  });
  const gateway = createGateway(createTestGatewayClient(request));
  const sessions = createSessionsHarness("main", ["agent:main:main"]);
  sessions.publish({
    result: {
      ...result,
      count: 2,
      sessions: [
        session("main", now, { unread: true }),
        session("main", now, { key: "agent:main:archived", unread: true, archived: true }),
      ],
    },
  });
  const mounted = await mountSidebar(gateway, sessions.sessions, "panel", agents);
  mounted.sidebar.connected = true;
  await mounted.sidebar.updateComplete;
  return mounted;
}

function agentIds(sidebar: HTMLElement) {
  return [...sidebar.querySelectorAll<HTMLElement>(".sidebar-agent-roster__row")].map(
    (row) => row.dataset.agentId,
  );
}

async function toggleRoster(sidebar: HTMLElement) {
  const trigger = sidebar.querySelector<HTMLButtonElement>(
    '.sidebar-agent-card__main, .sidebar-agent-roster button[aria-label="Switch agent"]',
  );
  if (!trigger) {
    throw new Error("Missing agent switch control");
  }
  trigger.click();
  await vi.waitFor(() => {
    expect(sidebar.querySelector('[value="command:sidebar-agents"]')).not.toBeNull();
  });
  const item = sidebar.querySelector('[value="command:sidebar-agents"]');
  sidebar
    .querySelector(".sidebar-agent-menu")
    ?.dispatchEvent(new CustomEvent("wa-select", { detail: { item }, bubbles: true }));
}

describe("AppSidebar agent roster", () => {
  it("orders selectable agents by work and recency, preserves cached unread counts, and switches agents", async () => {
    const { sidebar, context } = await mountRoster();
    const onNavigate = vi.fn();
    sidebar.onNavigate = onNavigate;
    sidebar.sidebarAgentsMode = "roster";

    await vi.waitFor(() => expect(agentIds(sidebar)).toEqual(["working", "recent", "main"]));
    const working = sidebar.querySelector<HTMLButtonElement>('[data-agent-id="working"]');
    expect(working?.textContent).toContain("Working: Preparing the project summary.");
    expect(
      sidebar.querySelectorAll('.sidebar-agent-roster__status[data-working="true"]'),
    ).toHaveLength(1);
    expect(sidebar.querySelector('[data-agent-id="recent"]')?.textContent).toMatch(/Active /);
    expect(
      sidebar.querySelector('[data-agent-id="main"] .sidebar-agent-roster__unread')?.textContent,
    ).toBe("1");
    expect(
      sidebar.querySelector('[data-agent-id="recent"] .sidebar-agent-roster__unread'),
    ).toBeNull();

    working?.click();
    await vi.waitFor(() => {
      expect(context.agentSelection.state).toEqual({ selectedId: "working", scopeId: "working" });
      expect(sidebar.querySelector('[data-agent-id="working"]')?.getAttribute("aria-pressed")).toBe(
        "true",
      );
    });
    expect(onNavigate).toHaveBeenCalledWith(
      "chat",
      expect.objectContaining({ pathname: "/chat/working" }),
    );
  });

  it("limits a large roster to the six most relevant agents and links to the full roster", async () => {
    const agents: AgentsListResult = {
      ...roster,
      agents: Array.from({ length: 8 }, (_, index) => ({ id: `agent-${index}` })),
    };
    const { sidebar } = await mountRoster(
      agents,
      agents.agents.map((agent, index) =>
        session(agent.id, index + 1, { hasActiveRun: index === 0 }),
      ),
    );
    sidebar.sidebarAgentsMode = "roster";
    await vi.waitFor(() =>
      expect(agentIds(sidebar)).toEqual([
        "agent-0",
        "agent-7",
        "agent-6",
        "agent-5",
        "agent-4",
        "agent-3",
      ]),
    );
    const link = sidebar.querySelector<HTMLAnchorElement>(
      '.sidebar-agent-roster__link[href="/agents"]',
    );
    expect(link?.textContent?.trim()).toBe("See all 8 agents");
  });

  it("persists the mode from the chip menu and lets the roster header turn it off", async () => {
    const { sidebar } = await mountRoster();
    expect(sidebar.querySelector(".sidebar-agent-card__main")).not.toBeNull();
    expect(sidebar.querySelector(".sidebar-agent-roster")).toBeNull();

    await toggleRoster(sidebar);
    await vi.waitFor(() => expect(agentIds(sidebar)).toHaveLength(3));
    expect(loadSettings().sidebarAgentsMode).toBe("roster");
    expect(sidebar.querySelector(".sidebar-agent-card__main")).toBeNull();

    await toggleRoster(sidebar);
    await vi.waitFor(() =>
      expect(sidebar.querySelector(".sidebar-agent-card__main")).not.toBeNull(),
    );
    expect(loadSettings().sidebarAgentsMode).toBe("chip");
    expect(sidebar.querySelector(".sidebar-agent-roster")).toBeNull();
  });
});
