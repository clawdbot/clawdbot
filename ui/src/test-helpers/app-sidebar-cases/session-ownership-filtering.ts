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

async function selectCreator(sidebar: SidebarLifecycleState, creatorId: string) {
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
  menu.dispatchEvent(
    new CustomEvent("wa-select", {
      bubbles: true,
      detail: { item: { value: `creator:${creatorId}` } },
    }),
  );
  await sidebar.updateComplete;
}

describe("AppSidebar session ownership filtering", () => {
  it("uses the complete owner facet instead of raw loaded-row principals", async () => {
    const harness = createSessionsHarness("main", [
      "agent:main:opaque-profile",
      "agent:main:discord-channel",
      "agent:main:session-principal",
    ]);
    const result = harness.sessions.state.result;
    if (!result) {
      throw new Error("expected session list");
    }
    const opaqueProfile = result.sessions.find((row) => row.key.endsWith(":opaque-profile"));
    const discordChannel = result.sessions.find((row) => row.key.endsWith(":discord-channel"));
    const sessionPrincipal = result.sessions.find((row) => row.key.endsWith(":session-principal"));
    if (!opaqueProfile || !discordChannel || !sessionPrincipal) {
      throw new Error("expected owner rows");
    }
    opaqueProfile.createdActor = {
      type: "human",
      id: "profile:channel:opaque",
      label: "Channel Keeper",
    };
    opaqueProfile.owner = { actor: opaqueProfile.createdActor };
    discordChannel.createdActor = { type: "human", id: "discord:channel:123" };
    sessionPrincipal.createdActor = {
      type: "agent",
      id: "agent:roboclaw:discord:channel:456",
    };
    result.creators = [
      { type: "human", id: "profile:channel:opaque", label: "Channel Keeper" },
      { type: "agent", id: "research", label: "Research" },
    ];

    const { sidebar } = await mountSidebar(
      createGateway({} as GatewayBrowserClient),
      harness.sessions,
    );
    harness.publishList({ result, agentId: "main" });
    await sidebar.updateComplete;
    sidebar.querySelector<HTMLButtonElement>(".sidebar-session-sort")?.click();
    await sidebar.updateComplete;

    const menu = sidebar.querySelector(".sidebar-session-sort-menu");
    expect(menu?.querySelector('[value="creator:profile:channel:opaque"]')).not.toBeNull();
    expect(menu?.textContent).toContain("Channel Keeper");
    expect(
      sidebar.querySelector(
        '[data-session-key="agent:main:opaque-profile"] openclaw-session-owner-chip',
      ),
    ).not.toBeNull();
    expect(
      sidebar.querySelector(
        '[data-session-key="agent:main:discord-channel"] openclaw-session-owner-chip',
      ),
    ).toBeNull();
    expect(
      sidebar.querySelector(
        '[data-session-key="agent:main:session-principal"] openclaw-session-owner-chip',
      ),
    ).toBeNull();
    expect(menu?.querySelector('[value="creator:discord:channel:123"]')).toBeNull();
    expect(menu?.querySelector('[value="creator:agent:roboclaw:discord:channel:456"]')).toBeNull();

    result.creators = undefined;
    harness.publishList({ result, agentId: "main" });
    await sidebar.updateComplete;

    const unavailableMenu = sidebar.querySelector(".sidebar-session-sort-menu");
    expect(unavailableMenu?.querySelector('[value^="creator:"]') ?? null).toBeNull();
    expect(unavailableMenu?.textContent ?? "").not.toContain("Channel Keeper");
  });

  it("filters by effective owner and hides custom groups without matching sessions", async () => {
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
    ada.createdActor = { type: "human", id: "profile-bob", label: "Bob" };
    ada.owner = {
      actor: { type: "human", id: "profile-ada", label: "Ada" },
      assignedBy: { type: "human", id: "profile-bob", label: "Bob" },
      assignedAt: 10,
    };
    ada.category = "Research";
    bob.createdActor = { type: "human", id: "profile-ada", label: "Ada" };
    bob.owner = {
      actor: { type: "human", id: "profile-bob", label: "Bob" },
      assignedBy: { type: "human", id: "profile-ada", label: "Ada" },
      assignedAt: 11,
    };
    bob.category = "Operations";
    result.creators = [
      { type: "human", id: "profile-ada", label: "Ada" },
      { type: "human", id: "profile-bob", label: "Bob" },
    ];
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

  it("filters adopted catalog rows by authoritative live ownership", async () => {
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
    adopted.createdActor = { type: "human", id: "profile-ada", label: "Ada" };
    adopted.owner = {
      actor: { type: "human", id: "profile-bob", label: "Bob" },
      assignedBy: { type: "human", id: "profile-ada", label: "Ada" },
      assignedAt: 10,
    };
    result.creators = [
      { type: "human", id: "profile-ada", label: "Ada" },
      { type: "human", id: "profile-bob", label: "Bob" },
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
                createdActor: { type: "human", id: "profile-ada", label: "Ada" },
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
    await selectCreator(sidebar, "profile-bob");

    expect(sidebar.querySelector(`[data-session-key="${backingSessionKey}"]`)).not.toBeNull();
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
      { type: "human", id: "profile-ada", label: "Ada" },
      { type: "human", id: "profile-bob", label: "Bob" },
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

  it("keeps the owner avatar leading while unread trails the row", async () => {
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
    unread.owner = { actor: unread.createdActor };
    unread.unread = true;
    other.createdActor = { type: "human", id: "profile-bob", label: "Bob" };
    other.owner = { actor: other.createdActor };
    result.creators = [
      { type: "human", id: "profile-ada", label: "Ada" },
      { type: "human", id: "profile-bob", label: "Bob" },
    ];

    const { sidebar } = await mountSidebar(
      createGateway({} as GatewayBrowserClient),
      harness.sessions,
    );
    harness.publishList({ result, agentId: "main" });
    await sidebar.updateComplete;

    const row = sidebar.querySelector(`[data-session-key="${key}"]`);
    expect(row?.querySelector(".session-glyph openclaw-session-owner-chip")).not.toBeNull();
    expect(row?.querySelector('.session-glyph__badge[aria-label="Unread"]')).toBeNull();
    expect(row?.querySelector(".session-row-state .sidebar-recent-session__unread")).not.toBeNull();
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
      owner: { actor: { type: "human", id: "profile-ada", label: "Ada" } },
      childSessions: [childKey],
    };
    result.creators = [
      { type: "human", id: "profile-ada", label: "Ada" },
      { type: "human", id: "profile-bob", label: "Bob" },
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
          owner: { actor: { type: "human", id: "profile-bob", label: "Bob" } },
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

  it("renders a controlled child once under its explicit dashboard parent", async () => {
    const gateway = createGateway({} as GatewayBrowserClient);
    const navigationParentKey = "agent:main:dashboard:navigation-parent";
    const controlParentKey = "agent:main:main";
    const childKey = "agent:main:subagent:controlled-child";
    const child = {
      key: childKey,
      kind: "direct" as const,
      label: "Controlled child",
      updatedAt: 3,
      parentSessionKey: navigationParentKey,
      spawnedBy: controlParentKey,
    };
    const harness = createSessionsHarness("main", [navigationParentKey]);
    harness.list.mockImplementation(async (options) => {
      const sessions = options?.spawnedBy === navigationParentKey ? [child] : [];
      return {
        ts: 3,
        path: "",
        count: sessions.length,
        defaults: { modelProvider: null, model: null, contextTokens: null },
        sessions,
      };
    });
    const { sidebar } = await mountSidebar(gateway, harness.sessions);
    harness.publishList({
      result: {
        ts: 3,
        path: "",
        count: 1,
        defaults: { modelProvider: null, model: null, contextTokens: null },
        sessions: [
          {
            key: navigationParentKey,
            kind: "direct",
            label: "Dashboard parent",
            updatedAt: 2,
            childSessions: [childKey],
          },
        ],
      },
    });
    await sidebar.updateComplete;
    expect(sidebar.querySelector(`[data-session-key="${childKey}"]`)).toBeNull();

    sidebar
      .querySelector<HTMLButtonElement>(`[data-child-session-toggle="${navigationParentKey}"]`)
      ?.click();
    await waitForFast(() =>
      expect(harness.list).toHaveBeenCalledWith(
        expect.objectContaining({ spawnedBy: navigationParentKey }),
      ),
    );
    await waitForFast(() =>
      expect(sidebar.querySelectorAll(`[data-session-key="${childKey}"]`)).toHaveLength(1),
    );
    expect(
      sidebar
        .querySelector(`[data-session-key="${childKey}"]`)
        ?.classList.contains("sidebar-recent-session--child"),
    ).toBe(true);
  });
});
