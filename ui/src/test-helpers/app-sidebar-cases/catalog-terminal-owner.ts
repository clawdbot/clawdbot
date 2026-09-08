import { describe, expect, it, vi } from "vitest";
import type {
  SessionCatalog,
  SessionsCatalogListResult,
} from "../../../../packages/gateway-protocol/src/index.ts";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationGatewaySnapshot } from "../../app/context.ts";
import { TERMINAL_PANEL_TOGGLE_EVENT } from "../../components/panel-toggle-contract.ts";
import { CATALOG_SESSION_CONTINUED_EVENT } from "../../lib/sessions/catalog-key.ts";
import { createGatewayHarness, createSessions, mountSidebar } from "../app-sidebar.ts";
import "../../components/app-sidebar.ts";

const catalogList = (sessions: Array<Record<string, unknown>>): SessionsCatalogListResult => ({
  catalogs: [
    {
      id: "codex",
      label: "Codex",
      capabilities: { continueSession: true, archive: true },
      hosts: [
        {
          hostId: "gateway:local",
          label: "Local Codex",
          kind: "gateway" as const,
          connected: true,
          sessions: sessions.map((session) => ({
            status: "idle",
            archived: false,
            canContinue: true,
            canArchive: true,
            ...session,
          })) as SessionCatalog["hosts"][number]["sessions"],
        },
      ],
    },
  ],
});

async function mountWithCatalog(
  result: SessionsCatalogListResult,
  sessionKeys = ["agent:main:main"],
) {
  const request = vi.fn().mockResolvedValue(result);
  const gateway = createGatewayHarness({ request } as unknown as GatewayBrowserClient);
  gateway.publish({
    hello: {
      features: { methods: ["sessions.catalog.list"] },
    } as ApplicationGatewaySnapshot["hello"],
  });
  const { sidebar } = await mountSidebar(gateway.gateway, createSessions("main", sessionKeys));
  sidebar.connected = true;
  await sidebar.updateComplete;
  await vi.advanceTimersByTimeAsync(0);
  await sidebar.updateComplete;
  return sidebar;
}

describe("AppSidebar catalog terminal ownership", () => {
  it("opens the catalog terminal menu with the rendered catalog owner", async () => {
    vi.useFakeTimers();
    try {
      const sidebar = await mountWithCatalog(
        catalogList([{ threadId: "thread-1", name: "Resume me", canOpenTerminal: true }]),
      );
      sidebar.terminalAvailable = true;
      await sidebar.updateComplete;
      const row = sidebar.querySelector('[data-session-key*="thread-1"]') as HTMLElement;
      (sidebar as unknown as { newSessionAgentId: string }).newSessionAgentId = "jarvis";
      row.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: 20,
          clientY: 30,
        }),
      );
      await sidebar.updateComplete;
      const menu = sidebar.querySelector("openclaw-catalog-session-menu") as HTMLElement & {
        onAction: (action: "viewer" | "terminal") => void;
        updateComplete: Promise<boolean>;
      };
      await menu.updateComplete;
      let detail: unknown;
      const listener = (event: Event) => {
        detail = (event as CustomEvent).detail;
      };
      window.addEventListener(TERMINAL_PANEL_TOGGLE_EVENT, listener);
      try {
        menu.onAction("terminal");
      } finally {
        window.removeEventListener(TERMINAL_PANEL_TOGGLE_EVENT, listener);
      }

      expect(detail).toEqual({
        open: true,
        agentId: "main",
        catalog: { catalogId: "codex", hostId: "gateway:local", threadId: "thread-1" },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a selected adopted catalog session as one row", async () => {
    vi.useFakeTimers();
    try {
      const sidebar = await mountWithCatalog(
        catalogList([
          {
            threadId: "thread-1",
            name: "Release checklist",
            sessionKey: "agent:main:adopted-codex",
          },
        ]),
        ["agent:main:main", "agent:main:adopted-codex"],
      );
      sidebar.sessionKey = "agent:main:adopted-codex";
      await sidebar.updateComplete;

      const rows = [...sidebar.querySelectorAll('[data-session-key="agent:main:adopted-codex"]')];
      expect(rows).toHaveLength(1);
      expect(rows[0]?.closest('[data-session-section="catalog:codex"]')).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("binds the adopted session immediately on the catalog-continued event", async () => {
    vi.useFakeTimers();
    try {
      const sidebar = await mountWithCatalog(
        catalogList([{ threadId: "thread-1", name: "Release checklist" }]),
        ["agent:main:main", "agent:main:adopted-codex"],
      );
      expect(
        sidebar.querySelectorAll('[data-session-key="agent:main:adopted-codex"]'),
      ).toHaveLength(1);

      document.dispatchEvent(
        new CustomEvent(CATALOG_SESSION_CONTINUED_EVENT, {
          detail: {
            catalogId: "codex",
            hostId: "gateway:local",
            threadId: "thread-1",
            agentId: "main",
            sessionKey: "agent:main:adopted-codex",
          },
        }),
      );
      await sidebar.updateComplete;

      const rows = [...sidebar.querySelectorAll('[data-session-key="agent:main:adopted-codex"]')];
      expect(rows).toHaveLength(1);
      expect(rows[0]?.closest('[data-session-section="catalog:codex"]')).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores a catalog adoption event owned by another agent", async () => {
    vi.useFakeTimers();
    try {
      const sidebar = await mountWithCatalog(
        catalogList([{ threadId: "thread-1", name: "Release checklist" }]),
      );

      document.dispatchEvent(
        new CustomEvent(CATALOG_SESSION_CONTINUED_EVENT, {
          detail: {
            catalogId: "codex",
            hostId: "gateway:local",
            threadId: "thread-1",
            agentId: "jarvis",
            sessionKey: "agent:jarvis:adopted-codex",
          },
        }),
      );
      await sidebar.updateComplete;

      const catalog = sidebar.querySelector('[data-session-section="catalog:codex"]');
      expect(catalog?.querySelector('[data-session-key="agent:jarvis:adopted-codex"]')).toBeNull();
      expect(
        catalog?.querySelector(
          '[data-session-key="agent:main:catalog:codex:gateway%3Alocal:thread-1"]',
        ),
      ).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
