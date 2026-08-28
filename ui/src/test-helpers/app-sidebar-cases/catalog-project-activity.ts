import { describe, expect, it } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { createGateway, createSessions, mountSidebar } from "../app-sidebar.ts";
import "../../components/app-sidebar.ts";

describe("AppSidebar project session activity", () => {
  it("preserves collapsed project sections stored by earlier versions", async () => {
    localStorage.setItem(
      "openclaw:sidebar:sessions:collapsed-sections",
      JSON.stringify(["catalog-project:codex:gateway:local:custom:repo"]),
    );
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
                threadId: "custom-group-thread",
                name: "Custom group session",
                customGroup: "repo",
                status: "idle",
                archived: false,
                canContinue: true,
                canArchive: true,
              },
              {
                threadId: "legacy-project-thread",
                name: "Legacy collapsed project",
                cwd: "custom:repo",
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

    const customGroup = sidebar.querySelector<HTMLButtonElement>(
      '[data-session-catalog-project="custom:repo"]',
    );
    const project = sidebar.querySelector<HTMLButtonElement>(
      '[data-session-catalog-project="project:custom:repo"]',
    );
    expect(customGroup?.getAttribute("aria-expanded")).toBe("false");
    expect(project?.getAttribute("aria-expanded")).toBe("false");
    expect(sidebar.querySelector('[data-session-key*="custom-group-thread"]')).toBeNull();
    expect(sidebar.querySelector('[data-session-key*="legacy-project-thread"]')).toBeNull();

    project?.click();
    await sidebar.updateComplete;
    expect(customGroup?.getAttribute("aria-expanded")).toBe("true");
    expect(
      JSON.parse(localStorage.getItem("openclaw:sidebar:sessions:collapsed-sections") ?? "[]"),
    ).not.toContain("catalog-project:codex:gateway:local:custom:repo");

    project?.click();
    await sidebar.updateComplete;
    customGroup?.click();
    await sidebar.updateComplete;
    expect(project?.getAttribute("aria-expanded")).toBe("false");
    expect(customGroup?.getAttribute("aria-expanded")).toBe("false");
    expect(
      JSON.parse(localStorage.getItem("openclaw:sidebar:sessions:collapsed-sections") ?? "[]"),
    ).toEqual([
      "catalog-project:codex:gateway:local:project:custom:repo",
      "catalog-custom:codex:gateway:local:custom:repo",
    ]);
  });

  it("preserves and migrates collapsed person sections stored by earlier versions", async () => {
    localStorage.setItem("openclaw:sidebar:sessions:catalog-grouping", "person");
    const legacySectionId = "catalog-project:codex:gateway:local:person:profile-ada";
    localStorage.setItem(
      "openclaw:sidebar:sessions:collapsed-sections",
      JSON.stringify([legacySectionId]),
    );
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
                threadId: "person-thread",
                name: "Ada's session",
                createdActor: { type: "human", id: "profile-ada", label: "Ada" },
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

    const person = sidebar.querySelector<HTMLButtonElement>(
      '[data-session-catalog-project="person:profile-ada"]',
    );
    expect(person?.getAttribute("aria-expanded")).toBe("false");
    expect(sidebar.querySelector('[data-session-key*="person-thread"]')).toBeNull();

    person?.click();
    await sidebar.updateComplete;
    expect(person?.getAttribute("aria-expanded")).toBe("true");
    person?.click();
    await sidebar.updateComplete;
    expect(
      JSON.parse(localStorage.getItem("openclaw:sidebar:sessions:collapsed-sections") ?? "[]"),
    ).toEqual(["catalog-person:codex:gateway:local:person:profile-ada"]);
  });

  it("preserves catalog menu focus when project groups reorder", async () => {
    const gateway = createGateway({} as GatewayBrowserClient);
    const { sidebar } = await mountSidebar(gateway, createSessions("main", ["agent:main:main"]));
    const sessions = [
      { threadId: "thread-a", name: "Project A", cwd: "/work/a" },
      { threadId: "thread-b", name: "Project B", cwd: "/work/b" },
    ];
    const setCatalog = async (orderedSessions: typeof sessions) => {
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
              sessions: orderedSessions.map((session) => ({
                ...session,
                status: "idle" as const,
                archived: false,
                canContinue: true,
                canArchive: true,
              })),
            },
          ],
        },
      ];
      sidebar.sessionData.requestSessionDataUpdate();
      await sidebar.updateComplete;
    };
    await setCatalog(sessions);

    const menu = sidebar.querySelector<HTMLButtonElement>(
      '[data-session-key*="thread-a"] [data-catalog-session-menu]',
    );
    menu?.focus();
    expect(document.activeElement).toBe(menu);

    await setCatalog(sessions.toReversed());

    expect(document.activeElement).toBe(menu);
  });

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
              {
                threadId: "loose-thread",
                name: "Loose session",
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

    const project = sidebar.querySelector(
      '[data-session-catalog-project="project:/work/openclaw"]',
    );
    const active = sidebar.querySelector('[data-session-key*="active-thread"]');
    const idle = sidebar.querySelector('[data-session-key*="idle-thread"]');
    const loose = sidebar.querySelector('[data-session-key*="loose-thread"]');
    const projectItem = project?.closest(".sidebar-session-catalog-project");
    const hostList = projectItem?.parentElement;
    const projectList = active?.closest('[role="list"]');
    expect(project).not.toBeNull();
    expect(hostList?.getAttribute("role")).toBe("list");
    expect(hostList?.getAttribute("aria-label")).toBe("Local Codex");
    expect(
      [...(hostList?.children ?? [])].every((item) => item.getAttribute("role") === "listitem"),
    ).toBe(true);
    expect(projectItem?.getAttribute("role")).toBe("listitem");
    expect(projectList?.getAttribute("aria-label")).toBe("Local Codex: openclaw");
    expect(
      [...(projectList?.children ?? [])].every((item) => item.getAttribute("role") === "listitem"),
    ).toBe(true);
    expect(idle?.closest('[role="list"]')).toBe(projectList);
    expect(loose?.parentElement).toBe(hostList);
    expect(loose?.getAttribute("role")).toBe("listitem");
    const activeState = active?.querySelector(".session-row-state");
    expect(activeState?.getAttribute("role")).toBe("img");
    expect(activeState?.getAttribute("aria-label")).toBe("Active run");
    expect(activeState?.querySelector(".session-run-spinner")).not.toBeNull();
    expect(active?.querySelector(".session-run-spinner")?.getAttribute("aria-label")).toBe(
      "Active run",
    );
    const activeLead = active?.querySelector(".sidebar-session-indicator");
    const idleLead = idle?.querySelector(".sidebar-session-indicator");
    expect(activeLead).not.toBeNull();
    expect(activeLead?.childElementCount).toBe(0);
    expect(idleLead).not.toBeNull();
    expect(idleLead?.childElementCount).toBe(0);
    expect(idle?.querySelector(".session-row-state")).toBeNull();
  });
});
