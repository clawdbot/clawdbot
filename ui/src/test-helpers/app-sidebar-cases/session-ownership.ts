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

  it("derives creator initials from agent labels and whole grapheme clusters", async () => {
    for (const { type, label, expected } of [
      { type: "agent" as const, label: "Roboclaw", expected: "R" },
      { type: "human" as const, label: "🦞小明", expected: "🦞" },
      { type: "human" as const, label: "👨‍👩‍👧‍👦Family", expected: "👨‍👩‍👧‍👦" },
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
      lobster.createdActor = { type, id: "profile-lobster", label };
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
    expect(menu.textContent).toContain("Owners");
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

  it("shows and requests Involving me for a participant session", async () => {
    // SAFETY: this sidebar fixture only needs the Gateway client surface supplied by its harness.
    const gateway = createGatewayHarness({} as GatewayBrowserClient);
    gateway.publish({ selfUser: { id: "profile-ada", name: "Ada" } });
    const harness = createSessionsHarness("main", ["agent:main:main", "agent:main:collab"]);
    const result = harness.sessions.state.result;
    const collab = result?.sessions.find((row) => row.key.endsWith(":collab"));
    if (!result || !collab) {
      throw new Error("expected participant row");
    }
    collab.createdActor = { type: "human", id: "profile-bob", label: "Bob" };
    collab.participants = [{ type: "human", id: "profile-ada", label: "Ada" }];
    collab.participantCount = 1;
    result.creators = [{ id: "profile-bob", label: "Bob" }];

    const { sidebar } = await mountSidebar(gateway.gateway, harness.sessions);
    harness.publishList({ result, agentId: "main" });
    await sidebar.updateComplete;
    expect(
      sidebar.querySelector('[data-session-key="agent:main:collab"] .session-owner-stack'),
    ).not.toBeNull();

    const menu = await openCreatorMenu(sidebar);
    expect(menu.querySelector('[value="involving-me"]')?.textContent).toContain("Involving me");
    menu.dispatchEvent(
      new CustomEvent("wa-select", {
        bubbles: true,
        detail: { item: { value: "involving-me" } },
      }),
    );
    await sidebar.updateComplete;
    expect(harness.setInvolvingMeFilter).toHaveBeenCalledWith(true);
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
        (title) => title.textContent?.trim() === "Owners",
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
});
