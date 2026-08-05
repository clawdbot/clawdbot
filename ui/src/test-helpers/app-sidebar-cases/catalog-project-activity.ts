import { describe, expect, it } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { createGateway, createSessions, mountSidebar } from "../app-sidebar.ts";
import "../../components/app-sidebar.ts";

describe("AppSidebar project session activity", () => {
  it("shows thread-style activity indicators", async () => {
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
                threadId: "active-thread",
                name: "Active session",
                cwd: "/work/openclaw",
                status: "active",
                archived: false,
                canContinue: false,
                canArchive: false,
              },
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

    const project = sidebar.querySelector('[data-session-catalog-project="/work/openclaw"]');
    const active = sidebar.querySelector('[data-session-key*="active-thread"]');
    const idle = sidebar.querySelector('[data-session-key*="idle-thread"]');
    expect(project).not.toBeNull();
    expect(active?.querySelector(".sidebar-session-indicator .session-run-spinner")).not.toBeNull();
    expect(active?.querySelector(".session-run-spinner")?.getAttribute("aria-label")).toBe(
      "Active run",
    );
    expect(
      idle?.querySelector(".sidebar-session-indicator .sidebar-session-indicator__dot"),
    ).not.toBeNull();
  });
});
