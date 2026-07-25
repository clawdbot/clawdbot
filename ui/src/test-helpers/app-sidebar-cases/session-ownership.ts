import { describe, expect, it } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import {
  createGateway,
  createSessionsHarness,
  mountSidebar,
  type SidebarLifecycleState,
} from "../app-sidebar.ts";
import { waitForFast } from "../wait-for.ts";
import "../../components/app-sidebar.ts";

async function openCreatorMenu(sidebar: SidebarLifecycleState): Promise<HTMLElement> {
  const trigger = sidebar.querySelector<HTMLButtonElement>(".sidebar-session-sort");
  if (!trigger) {
    throw new Error("expected session sort trigger");
  }
  trigger.click();
  await sidebar.updateComplete;
  const menu = sidebar.querySelector<HTMLElement>(".sidebar-session-sort-menu");
  if (!menu) {
    throw new Error("expected session sort menu");
  }
  return menu;
}

async function selectCreator(sidebar: SidebarLifecycleState, creatorId: string | null) {
  const menu = await openCreatorMenu(sidebar);
  menu.dispatchEvent(
    new CustomEvent("wa-select", {
      bubbles: true,
      detail: { item: { value: `creator:${creatorId ?? ""}` } },
    }),
  );
  await sidebar.updateComplete;
}

describe("AppSidebar session ownership", () => {
  it("uses the complete facet and requests unloaded creators from the Gateway", async () => {
    const gateway = createGateway({} as GatewayBrowserClient);
    const harness = createSessionsHarness("main", ["agent:main:main", "agent:main:ada"]);
    const result = harness.sessions.state.result;
    if (!result) {
      throw new Error("expected session list");
    }
    const ada = result.sessions.find((row) => row.key.endsWith(":ada"));
    if (!ada) {
      throw new Error("expected creator row");
    }
    ada.createdActor = { type: "human", id: "profile-ada", label: "Ada" };
    result.creators = [
      { id: "profile-ada", label: "Ada" },
      { id: "profile-bob", label: "Bob" },
    ];

    const { sidebar } = await mountSidebar(gateway, harness.sessions);
    harness.publishList({ result, agentId: "main" });
    await sidebar.updateComplete;

    expect(sidebar.sessionData.sessionsResult?.creators).toHaveLength(2);
    expect(sidebar.querySelector('[data-session-key="agent:main:ada"]')).not.toBeNull();
    expect(sidebar.querySelectorAll("openclaw-session-owner-chip")).toHaveLength(1);
    const menu = await openCreatorMenu(sidebar);
    expect(menu.textContent).toContain("People");
    expect(menu.querySelector('[value="creator:"]')).not.toBeNull();
    expect(menu.querySelector('[value="creator:profile-ada"]')).not.toBeNull();
    expect(menu.querySelector('[value="creator:profile-bob"]')).not.toBeNull();
    menu.dispatchEvent(
      new CustomEvent("wa-select", {
        bubbles: true,
        detail: { item: { value: "creator:profile-bob" } },
      }),
    );
    await sidebar.updateComplete;
    expect(harness.setCreatorFilter).toHaveBeenCalledWith("profile-bob");

    result.creators = [{ id: "profile-bob", label: "Bob" }];
    harness.publishList({ result, agentId: "main" });
    await sidebar.updateComplete;
    await sidebar.updateComplete;
    expect(harness.setCreatorFilter).toHaveBeenLastCalledWith(null);
  });

  it("renders no ownership chrome when the listed sessions have fewer than two creators", async () => {
    const gateway = createGateway({} as GatewayBrowserClient);
    const harness = createSessionsHarness("main", [
      "agent:main:main",
      "agent:main:a",
      "agent:main:b",
    ]);
    const result = harness.sessions.state.result;
    if (!result) {
      throw new Error("expected session list");
    }
    for (const row of result.sessions) {
      row.createdActor = { type: "human", id: "profile-ada", label: "Ada" };
    }
    const { sidebar } = await mountSidebar(gateway, harness.sessions);
    harness.publishList({ result, agentId: "main" });
    await sidebar.updateComplete;

    const menu = await openCreatorMenu(sidebar);
    expect(
      [...menu.querySelectorAll(".sidebar-session-sort-menu__title")].some(
        (title) => title.textContent?.trim() === "People",
      ),
    ).toBe(false);
    expect(menu.querySelector('[value^="creator:"]')).toBeNull();
    expect(sidebar.querySelector("openclaw-session-owner-chip")).toBeNull();
  });

  it("shows archive attribution only in collaborative archived-session lists", async () => {
    const gateway = createGateway({} as GatewayBrowserClient);
    const harness = createSessionsHarness("main", [
      "agent:main:main",
      "agent:main:archived",
      "agent:main:collaborator",
    ]);
    const result = harness.sessions.state.result;
    if (!result) {
      throw new Error("expected session list");
    }
    const archived = result.sessions.find((row) => row.key.endsWith(":archived"));
    const collaborator = result.sessions.find((row) => row.key.endsWith(":collaborator"));
    if (!archived || !collaborator) {
      throw new Error("expected archive attribution rows");
    }
    archived.archived = true;
    archived.archivedBy = { type: "human", id: "profile-bob", label: "Bob" };
    archived.createdActor = { type: "human", id: "profile-ada", label: "Ada" };
    collaborator.createdActor = { type: "human", id: "profile-bob", label: "Bob" };
    result.creators = [
      { id: "profile-ada", label: "Ada" },
      { id: "profile-bob", label: "Bob" },
    ];

    const { sidebar } = await mountSidebar(gateway, harness.sessions);
    Object.assign(sidebar, { sessionsStatusFilter: "archived" });
    harness.publishList({ result, agentId: "main" });
    await sidebar.updateComplete;

    expect(
      sidebar.querySelector('openclaw-session-owner-chip span[title="Archived by Bob"]'),
    ).not.toBeNull();
    expect(sidebar.querySelector('span[title="Created by Ada"]')).toBeNull();

    collaborator.createdActor = { type: "human", id: "profile-ada", label: "Ada" };
    result.creators = [{ id: "profile-ada", label: "Ada" }];
    harness.publishList({ result, agentId: "main" });
    await sidebar.updateComplete;

    expect(sidebar.querySelector("openclaw-session-owner-chip")).toBeNull();
  });

  it("filters by creator and hides custom groups without matching sessions", async () => {
    const gateway = createGateway({} as GatewayBrowserClient);
    const harness = createSessionsHarness("main", [
      "agent:main:main",
      "agent:main:ada",
      "agent:main:bob",
    ]);
    const result = harness.sessions.state.result;
    if (!result) {
      throw new Error("expected session list");
    }
    const ada = result.sessions.find((row) => row.key.endsWith(":ada"));
    const bob = result.sessions.find((row) => row.key.endsWith(":bob"));
    if (!ada || !bob) {
      throw new Error("expected creator rows");
    }
    ada.createdActor = { type: "human", id: "profile-ada", label: "Ada" };
    ada.category = "Research";
    bob.createdActor = { type: "human", id: "profile-bob", label: "Bob" };
    bob.category = "Operations";
    harness.publish({ groups: ["Research", "Operations"] });
    const { sidebar } = await mountSidebar(gateway, harness.sessions);
    harness.publishList({ result, agentId: "main" });
    await sidebar.updateComplete;

    expect(sidebar.querySelectorAll("openclaw-session-owner-chip")).toHaveLength(2);

    await selectCreator(sidebar, "profile-ada");

    expect(sidebar.querySelector('[data-session-key="agent:main:ada"]')).not.toBeNull();
    expect(sidebar.querySelector('[data-session-key="agent:main:bob"]')).toBeNull();
    expect(sidebar.querySelector('[data-session-section="category:Research"]')).not.toBeNull();
    expect(sidebar.querySelector('[data-session-section="category:Operations"]')).toBeNull();
    expect(sidebar.querySelector(".sidebar-session-sort--filtered")).not.toBeNull();
  });

  it("filters catalog rows by authoritative creator ownership", async () => {
    const gateway = createGateway({} as GatewayBrowserClient);
    const backingSessionKey = "agent:main:claude-bound";
    const harness = createSessionsHarness("main", [
      "agent:main:main",
      "agent:main:ada",
      backingSessionKey,
    ]);
    const result = harness.sessions.state.result;
    if (!result) {
      throw new Error("expected session list");
    }
    const ada = result.sessions.find((row) => row.key.endsWith(":ada"));
    const adopted = result.sessions.find((row) => row.key === backingSessionKey);
    if (!ada || !adopted) {
      throw new Error("expected ownership rows");
    }
    ada.createdActor = { type: "human", id: "profile-ada", label: "Ada" };
    adopted.createdActor = { type: "human", id: "profile-bob", label: "Bob" };
    result.creators = [
      { id: "profile-ada", label: "Ada" },
      { id: "profile-bob", label: "Bob" },
    ];

    const { sidebar } = await mountSidebar(gateway, harness.sessions);
    sidebar.sessionData.sessionCatalogs = [
      {
        id: "claude",
        label: "Claude Code",
        capabilities: { continueSession: true, archive: false },
        hosts: [
          {
            hostId: "gateway:local",
            label: "Local Claude",
            kind: "gateway",
            connected: true,
            sessions: [
              {
                threadId: "claude-thread",
                name: "Claude session",
                status: "stored",
                archived: false,
                sessionKey: backingSessionKey,
                createdActor: { type: "human", id: "profile-bob", label: "Bob" },
                canContinue: true,
                canArchive: false,
              },
              {
                threadId: "external-thread",
                name: "External unowned session",
                status: "stored",
                archived: false,
                canContinue: true,
                canArchive: false,
              },
            ],
          },
        ],
      },
    ];
    sidebar.sessionData.requestSessionDataUpdate();
    harness.publishList({ result, agentId: "main" });
    await sidebar.updateComplete;

    expect(sidebar.querySelector(`[data-session-key="${backingSessionKey}"]`)).not.toBeNull();
    expect(sidebar.textContent).toContain("External unowned session");
    await selectCreator(sidebar, "profile-ada");

    expect(sidebar.querySelector(`[data-session-key="${backingSessionKey}"]`)).toBeNull();
    expect(sidebar.textContent).not.toContain("External unowned session");

    harness.publishList({
      result: { ...result, count: 1, sessions: [ada] },
      agentId: "main",
    });
    await sidebar.updateComplete;

    expect(sidebar.querySelector(`[data-session-key="${backingSessionKey}"]`)).toBeNull();
    expect(sidebar.textContent).not.toContain("External unowned session");
  });

  it("keeps catalog rows whose backing ownership is outside the loaded page", async () => {
    const gateway = createGateway({} as GatewayBrowserClient);
    const harness = createSessionsHarness("main", [
      "agent:main:main",
      "agent:main:ada",
      "agent:main:bob",
    ]);
    const result = harness.sessions.state.result;
    if (!result) {
      throw new Error("expected session list");
    }
    const ada = result.sessions.find((row) => row.key.endsWith(":ada"));
    const bob = result.sessions.find((row) => row.key.endsWith(":bob"));
    if (!ada || !bob) {
      throw new Error("expected creator rows");
    }
    ada.createdActor = { type: "human", id: "profile-ada", label: "Ada" };
    bob.createdActor = { type: "human", id: "profile-bob", label: "Bob" };
    result.creators = [
      { id: "profile-ada", label: "Ada" },
      { id: "profile-bob", label: "Bob" },
    ];

    const unloadedSessionKey = "agent:main:beyond-loaded-page";
    const { sidebar } = await mountSidebar(gateway, harness.sessions);
    sidebar.sessionData.sessionCatalogs = [
      {
        id: "claude",
        label: "Claude Code",
        capabilities: { continueSession: true, archive: false },
        hosts: [
          {
            hostId: "gateway:local",
            label: "Local Claude",
            kind: "gateway",
            connected: true,
            sessions: [
              {
                threadId: "unloaded-thread",
                name: "Unloaded backing session",
                status: "stored",
                archived: false,
                sessionKey: unloadedSessionKey,
                createdActor: { type: "human", id: "profile-ada", label: "Ada" },
                canContinue: true,
                canArchive: false,
              },
            ],
          },
        ],
      },
    ];
    sidebar.sessionData.requestSessionDataUpdate();
    harness.publishList({ result, agentId: "main" });
    await sidebar.updateComplete;

    await selectCreator(sidebar, "profile-ada");

    expect(sidebar.querySelector(`[data-session-key="${unloadedSessionKey}"]`)).not.toBeNull();
  });

  it("renders unread state as a corner badge on an owner avatar", async () => {
    const key = "agent:main:unread";
    const harness = createSessionsHarness("main", ["agent:main:main", key, "agent:main:other"]);
    const result = harness.sessions.state.result;
    if (!result) {
      throw new Error("expected session list");
    }
    const unread = result.sessions.find((row) => row.key === key);
    const other = result.sessions.find((row) => row.key.endsWith(":other"));
    if (!unread || !other) {
      throw new Error("expected ownership rows");
    }
    unread.createdActor = { type: "human", id: "profile-ada", label: "Ada" };
    unread.unread = true;
    other.createdActor = { type: "human", id: "profile-bob", label: "Bob" };
    result.creators = [
      { id: "profile-ada", label: "Ada" },
      { id: "profile-bob", label: "Bob" },
    ];

    const { sidebar } = await mountSidebar(
      createGateway({} as GatewayBrowserClient),
      harness.sessions,
    );
    harness.publishList({ result, agentId: "main" });
    await sidebar.updateComplete;

    const row = sidebar.querySelector(`[data-session-key="${key}"]`);
    expect(
      row?.querySelector(".sidebar-session-avatar openclaw-session-owner-chip"),
    ).not.toBeNull();
    expect(
      row?.querySelector('.sidebar-session-avatar__badge[aria-label="Unread"]'),
    ).not.toBeNull();
    expect(row?.querySelector(".sidebar-recent-session__unread")).toBeNull();
    expect(row?.querySelector(".sidebar-session-indicator__dot")).toBeNull();
  });

  it("keeps owner avatars off child rows", async () => {
    const parentKey = "agent:main:parent";
    const childKey = "agent:main:child";
    const harness = createSessionsHarness("main", [parentKey]);
    const result = harness.sessions.state.result;
    if (!result) {
      throw new Error("expected session list");
    }
    const parentRow = result.sessions[0];
    if (!parentRow) {
      throw new Error("expected parent row");
    }
    result.sessions[0] = {
      ...parentRow,
      key: parentKey,
      createdActor: { type: "human", id: "profile-ada", label: "Ada" },
      childSessions: [childKey],
    };
    result.creators = [
      { id: "profile-ada", label: "Ada" },
      { id: "profile-bob", label: "Bob" },
    ];
    harness.list.mockResolvedValue({
      ts: 2,
      path: "",
      count: 1,
      defaults: { modelProvider: null, model: null, contextTokens: null },
      sessions: [
        {
          key: childKey,
          spawnedBy: parentKey,
          kind: "direct",
          label: "Child task",
          updatedAt: 2,
          status: "done",
          createdActor: { type: "human", id: "profile-bob", label: "Bob" },
        },
      ],
    });

    const { sidebar } = await mountSidebar(
      createGateway({} as GatewayBrowserClient),
      harness.sessions,
    );
    harness.publishList({ result, agentId: "main" });
    await sidebar.updateComplete;
    sidebar.querySelector<HTMLButtonElement>(`[data-child-session-toggle="${parentKey}"]`)?.click();
    await waitForFast(() =>
      expect(sidebar.querySelector(`[data-session-key="${childKey}"]`)).not.toBeNull(),
    );

    expect(
      sidebar.querySelector(`[data-session-key="${parentKey}"] openclaw-session-owner-chip`),
    ).not.toBeNull();
    expect(
      sidebar.querySelector(`[data-session-key="${childKey}"] openclaw-session-owner-chip`),
    ).toBeNull();
    expect(
      sidebar.querySelector(`[data-session-key="${childKey}"] [aria-label="Done"]`),
    ).not.toBeNull();
  });
});
