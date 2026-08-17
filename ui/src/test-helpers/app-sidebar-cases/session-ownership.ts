import { describe, expect, it } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationGatewaySnapshot } from "../../app/context.ts";
import {
  createGateway,
  createGatewayHarness,
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

async function selectSessionMenuValue(sidebar: SidebarLifecycleState, value: string) {
  const menu = await openCreatorMenu(sidebar);
  expect(menu.querySelector(`[value="${value}"]`)).not.toBeNull();
  menu.dispatchEvent(
    new CustomEvent("wa-select", {
      bubbles: true,
      detail: { item: { value } },
    }),
  );
  await sidebar.updateComplete;
}

async function selectCreator(sidebar: SidebarLifecycleState, creatorId: string | null) {
  await selectSessionMenuValue(sidebar, `creator:${creatorId ?? ""}`);
}

async function selectSort(sidebar: SidebarLifecycleState, mode: string) {
  await selectSessionMenuValue(sidebar, `sort:${mode}`);
}

async function expectSort(sidebar: SidebarLifecycleState, mode: string, keys: string[]) {
  await selectSort(sidebar, mode);
  expect(visibleSessionKeys(sidebar)).toEqual(keys);
}

function sessionSharingHello(hasMultipleIdentities: boolean) {
  return {
    policy: { hasMultipleSessionSharingIdentities: hasMultipleIdentities },
  } as ApplicationGatewaySnapshot["hello"];
}

function visibleSessionKeys(sidebar: SidebarLifecycleState): string[] {
  return [...sidebar.querySelectorAll<HTMLElement>(".sidebar-recent-session[data-session-key]")]
    .filter((row) => !row.classList.contains("sidebar-recent-session--child"))
    .map((row) => row.dataset.sessionKey ?? "");
}

describe("AppSidebar session ownership", () => {
  it("renders durable actor avatars identically regardless of live presence", async () => {
    const gateway = createGatewayHarness({} as GatewayBrowserClient);
    gateway.publish({
      selfUser: {
        id: "profile-ada",
        name: "Ada",
        avatarUrl: "/api/users/profile-ada/avatar?v=1",
      },
    });
    const harness = createSessionsHarness("main", [
      "agent:main:main",
      "agent:main:ada",
      "agent:main:bob",
      "agent:main:carol",
    ]);
    const result = harness.sessions.state.result;
    if (!result) {
      throw new Error("expected session list");
    }
    const ada = result.sessions.find((row) => row.key.endsWith(":ada"));
    const bob = result.sessions.find((row) => row.key.endsWith(":bob"));
    const carol = result.sessions.find((row) => row.key.endsWith(":carol"));
    if (!ada || !bob || !carol) {
      throw new Error("expected creator rows");
    }
    ada.createdActor = {
      type: "human",
      id: "profile-ada",
      label: "Ada",
      avatarUrl: "/api/users/profile-ada/avatar?v=1",
    };
    bob.createdActor = {
      type: "human",
      id: "profile-bob",
      label: "Bob",
      avatarUrl: "/api/users/profile-bob/avatar?v=2",
    };
    carol.createdActor = { type: "human", id: "profile-carol", label: "Carol" };
    result.creators = [
      { id: "profile-ada", label: "Ada" },
      { id: "profile-bob", label: "Bob" },
      { id: "profile-carol", label: "Carol" },
    ];

    const { sidebar } = await mountSidebar(gateway.gateway, harness.sessions);
    harness.publishList({ result, agentId: "main" });

    await waitForFast(() => {
      expect(
        sidebar.querySelector('[data-session-key="agent:main:ada"] openclaw-viewer-avatar img'),
      ).not.toBeNull();
      expect(
        sidebar.querySelector('[data-session-key="agent:main:bob"] openclaw-viewer-avatar img'),
      ).not.toBeNull();
    });
    const bobAvatarBefore = sidebar
      .querySelector('[data-session-key="agent:main:bob"] openclaw-viewer-avatar img')
      ?.getAttribute("src");
    expect(
      sidebar
        .querySelector('[data-session-key="agent:main:bob"] .session-owner-chip')
        ?.classList.contains("session-owner-chip--away"),
    ).toBe(true);

    gateway.publishEvent("presence", {
      presence: [
        {
          instanceId: "bob-browser",
          user: {
            id: "profile-bob",
            name: "Bob",
            avatarUrl: "/api/users/profile-bob/avatar?v=99",
          },
          watchedSessions: ["agent:main:bob"],
        },
      ],
    });
    await sidebar.updateComplete;
    expect(
      sidebar
        .querySelector('[data-session-key="agent:main:bob"] openclaw-viewer-avatar img')
        ?.getAttribute("src"),
    ).toBe(bobAvatarBefore);
    const bobChip = sidebar.querySelector(
      '[data-session-key="agent:main:bob"] .session-owner-chip',
    );
    expect(bobChip?.classList.contains("session-owner-chip--away")).toBe(false);
    expect(bobChip?.getAttribute("title")).toBe("Created by Bob · viewing now");

    const adaChip = sidebar.querySelector(
      '[data-session-key="agent:main:ada"] .session-owner-chip',
    );
    expect(adaChip?.getAttribute("aria-label")).toBe("Created by Ada");
    expect(adaChip?.getAttribute("title")).toBe("Created by Ada");
    const adaImage = adaChip?.querySelector("img");
    adaImage?.dispatchEvent(new Event("error"));
    expect(adaChip?.querySelector(".viewer-avatar")?.classList.contains("is-fallback")).toBe(true);

    const carolChip = sidebar.querySelector(
      '[data-session-key="agent:main:carol"] .session-owner-chip',
    );
    expect(carolChip?.querySelector("openclaw-viewer-avatar")).toBeNull();
    expect(carolChip?.textContent?.trim()).toBe("C");
  });

  it("keeps emoji display-name initials as whole grapheme clusters", async () => {
    for (const { label, expected } of [
      { label: "🦞小明", expected: "🦞" },
      { label: "👨‍👩‍👧‍👦Family", expected: "👨‍👩‍👧‍👦" },
    ]) {
      const gateway = createGateway({} as GatewayBrowserClient);
      const harness = createSessionsHarness("main", ["agent:main:main", "agent:main:lobster"]);
      const result = harness.sessions.state.result;
      if (!result) {
        throw new Error("expected session list");
      }
      const lobster = result.sessions.find((row) => row.key.endsWith(":lobster"));
      if (!lobster) {
        throw new Error("expected creator row");
      }
      lobster.createdActor = { type: "human", id: "profile-lobster", label };
      result.creators = [
        { id: "profile-lobster", label },
        { id: "profile-ada", label: "Ada" },
      ];

      const { sidebar } = await mountSidebar(gateway, harness.sessions);
      harness.publishList({ result, agentId: "main" });
      await sidebar.updateComplete;

      const chip = sidebar.querySelector(
        '[data-session-key="agent:main:lobster"] .session-owner-chip',
      );
      expect(chip?.textContent?.trim()).toBe(expected);
    }
  });

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
    const gateway = createGatewayHarness({} as GatewayBrowserClient);
    gateway.publish({
      selfUser: {
        id: "profile-ada",
        name: "Ada",
        avatarUrl: "/api/users/profile-ada/avatar",
      },
    });
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
    const { sidebar } = await mountSidebar(gateway.gateway, harness.sessions);
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

  it("owns People availability and fallback at the server identity capability", async () => {
    const gateway = createGatewayHarness({} as GatewayBrowserClient);
    const keys = ["main", "b1", "a1", "b2", "a2"].map((id) => `agent:main:${id}`);
    const harness = createSessionsHarness("main", keys);
    const result = harness.sessions.state.result;
    if (!result) {
      throw new Error("expected session list");
    }
    for (const [index, id, label, updatedAt] of [
      [1, "profile-bob", "Bob", 40],
      [2, "profile-ada", "Ada", 40],
      [3, "profile-bob", "Bob", 30],
      [4, "profile-ada", "Ada", 20],
    ] as const) {
      Object.assign(result.sessions[index]!, {
        createdActor: { type: "human", id, label },
        updatedAt,
      });
    }
    result.creators = [{ id: "profile-bob", label: "Bob" }];
    const createdOrder = keys.slice(1);
    // b1 and a1 tie at updatedAt 40; the ascending-key tie-break (mirroring
    // the gateway list order) puts a1 first.
    const updatedOrder = [keys[2]!, keys[1]!, keys[3]!, keys[4]!];
    const peopleOrder = [keys[2]!, keys[4]!, keys[1]!, keys[3]!];

    const { sidebar } = await mountSidebar(gateway.gateway, harness.sessions);
    harness.publishList({ result, agentId: "main" });
    await sidebar.updateComplete;

    let menu = await openCreatorMenu(sidebar);
    expect(menu.querySelector('[value="sort:people"]')).toBeNull();
    expect(menu.querySelector('[value="sort:created"]')?.getAttribute("aria-checked")).toBe("true");
    menu.dispatchEvent(new Event("wa-after-hide", { bubbles: true }));
    await sidebar.updateComplete;

    gateway.publish({ hello: sessionSharingHello(true) });
    await sidebar.updateComplete;
    await expectSort(sidebar, "people", peopleOrder);

    gateway.publish({ hello: null });
    await sidebar.updateComplete;
    menu = await openCreatorMenu(sidebar);
    expect(menu.querySelector('[value="sort:people"]')).toBeNull();
    expect(menu.querySelector('[value="sort:created"]')?.getAttribute("aria-checked")).toBe("true");
    menu.dispatchEvent(new Event("wa-after-hide", { bubbles: true }));
    await sidebar.updateComplete;

    gateway.publish({ hello: sessionSharingHello(true) });
    await sidebar.updateComplete;
    expect(visibleSessionKeys(sidebar)).toEqual(peopleOrder);

    await expectSort(sidebar, "updated", updatedOrder);
    await expectSort(sidebar, "created", createdOrder);
    await expectSort(sidebar, "people", peopleOrder);
    result.creators = [
      { id: "profile-ada", label: "Ada" },
      { id: "profile-bob", label: "Bob" },
    ];
    harness.publishList({ result, agentId: "main" });
    gateway.publish({ hello: sessionSharingHello(false) });
    await sidebar.updateComplete;
    await sidebar.updateComplete;

    menu = await openCreatorMenu(sidebar);
    expect(menu.querySelector('[value="sort:people"]')).toBeNull();
    expect(menu.querySelector('[value="sort:created"]')?.getAttribute("aria-checked")).toBe("true");
    menu.dispatchEvent(new Event("wa-after-hide", { bubbles: true }));
    gateway.publish({ hello: sessionSharingHello(true) });
    await sidebar.updateComplete;
    menu = await openCreatorMenu(sidebar);
    expect(menu.querySelector('[value="sort:people"]')).not.toBeNull();
    expect(menu.querySelector('[value="sort:created"]')?.getAttribute("aria-checked")).toBe("true");
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
    // Facepile dedup follows the rendered lead: the archivist chip is shown,
    // so Bob is excluded while creator Ada must stay visible as a viewer.
    const archivedFacepile = sidebar.querySelector(
      '[data-session-key="agent:main:archived"] openclaw-viewer-facepile',
    ) as (HTMLElement & { excludeUserId?: string }) | null;
    expect(archivedFacepile?.excludeUserId).toBe("profile-bob");

    collaborator.createdActor = { type: "human", id: "profile-ada", label: "Ada" };
    result.creators = [{ id: "profile-ada", label: "Ada" }];
    harness.publishList({ result, agentId: "main" });
    await sidebar.updateComplete;

    expect(sidebar.querySelector("openclaw-session-owner-chip")).toBeNull();
    const soloFacepile = sidebar.querySelector(
      '[data-session-key="agent:main:archived"] openclaw-viewer-facepile',
    ) as (HTMLElement & { excludeUserId?: string }) | null;
    expect(soloFacepile?.excludeUserId).toBeUndefined();
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
