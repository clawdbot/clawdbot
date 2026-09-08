import type { LitElement } from "lit";
import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import {
  createGatewayHarness,
  createSessions,
  createSessionsHarness,
  mountSidebar,
} from "../app-sidebar.ts";
import { selectSessionMenuValue } from "./session-ownership.ts";
import "../../components/app-sidebar.ts";

await import("../../components/viewer-facepile.ts");

describe("AppSidebar viewer presence", () => {
  it.each([
    ["profile-bob", "bob"],
    ["gateway-owner", "Shared owner"],
  ])("shows presence and offline owner %s while excluding self", async (ownerId, ownerName) => {
    const client = { instanceId: "self-instance" } as GatewayBrowserClient;
    const gateway = createGatewayHarness(client);
    const owners = ["self", "ada", "bob"].map((name) => ({
      type: "human" as const,
      id: name === "bob" ? ownerId : `profile-${name}`,
      identity: { type: "profile" as const, id: name === "bob" ? ownerId : `profile-${name}` },
      label: name,
    }));
    const sessions = createSessionsHarness(
      "main",
      owners.map((owner) => `agent:main:${owner.id}`),
    );
    const result = sessions.sessions.state.result!;
    result.owners = owners;
    result.sessions.forEach((row, index) => {
      row.owner = { actor: owners[index]! };
    });
    sessions.publishList({ result });
    const { sidebar } = await mountSidebar(gateway.gateway, sessions.sessions);
    sidebar.connected = true;
    await selectSessionMenuValue(sidebar, "grouping:person");
    const section = (id: string) =>
      sidebar.querySelector(
        `[data-session-section="person:profile:${id === "bob" ? ownerId : `profile-${id}`}"]`,
      )!;
    for (const id of ["self", "ada", "bob"]) {
      expect(section(id)).not.toBeNull();
    }
    expect(section("bob").querySelector(".sidebar-recent-sessions__label-text")?.textContent).toBe(
      ownerName,
    );
    expect(section("bob").querySelector("[data-person-card]")?.getAttribute("aria-label")).toBe(
      `Details for ${ownerName}`,
    );
    const self = {
      instanceId: client.instanceId,
      user: { id: "profile-self", identity: owners[0]!.identity, name: "Self" },
      lastInputSeconds: 0,
    };
    const ada = {
      instanceId: "ada-instance",
      user: { id: "profile-ada", identity: owners[1]!.identity, name: "Ada" },
      lastInputSeconds: 5,
    };
    gateway.publishEvent("presence", { presence: [self, ada] });
    await sidebar.updateComplete;
    const dot = () => section("ada").querySelector(".sidebar-session-group-presence");
    const personButton = section("ada").querySelector<HTMLButtonElement>("[data-person-card]")!;
    expect(dot()?.getAttribute("aria-label")).toBe("Online");
    expect(dot()?.classList.contains("sidebar-session-group-presence--idle")).toBe(false);
    expect(dot()!.id).toBeTruthy();
    expect(personButton.getAttribute("aria-describedby")).toBe(dot()!.id);
    expect(section("bob").querySelector(".sidebar-session-group-presence")).toBeNull();
    expect(section("self").querySelector(".sidebar-session-group-presence")).toBeNull();
    expect(section("self").querySelector("[data-person-card]")).toBeNull();
    expect(
      section("self").querySelector(
        ".sidebar-session-group-toggle .sidebar-recent-sessions__label-text",
      )?.textContent,
    ).toBe("self");

    const toggle = section("ada").querySelector<HTMLButtonElement>(
      ".sidebar-session-group-toggle",
    )!;
    expect(personButton?.tagName).toBe("BUTTON");
    expect(personButton.getAttribute("aria-haspopup")).toBe("dialog");
    expect(personButton.getAttribute("aria-label")).toBe("Details for ada");
    expect(personButton.previousElementSibling).toBe(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    personButton.click();
    await vi.dynamicImportSettled();
    await vi.waitFor(() =>
      expect(document.querySelector(".person-activity-hovercard h2")?.textContent).toBe("Ada"),
    );
    const card = document.querySelector<HTMLElement>(".person-activity-hovercard")!;
    expect(card.querySelector(".person-activity-card__status")?.textContent?.trim()).toBe("Online");
    expect(personButton.getAttribute("aria-expanded")).toBe("true");
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    card.querySelector<HTMLAnchorElement>("a")!.focus();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(document.querySelector(".person-activity-hovercard")).toBeNull();
    expect(document.activeElement).toBe(personButton);
    expect(personButton.getAttribute("aria-expanded")).toBe("false");
    // A real chevron press lands outside the person button: it collapses the
    // section and dismisses an open card through the outside-pointer handling.
    personButton.click();
    await vi.waitFor(() =>
      expect(document.querySelector(".person-activity-hovercard")).not.toBeNull(),
    );
    toggle.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    toggle.click();
    await sidebar.updateComplete;
    expect(section("ada").querySelector("[data-session-key]")).toBeNull();
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(document.querySelector(".person-activity-hovercard")).toBeNull();

    const bobButton = section("bob").querySelector<HTMLButtonElement>("[data-person-card]")!;
    bobButton.click();
    await vi.dynamicImportSettled();
    await vi.waitFor(() =>
      expect(document.querySelector(".person-activity-hovercard h2")?.textContent).toBe(ownerName),
    );
    const offlineCard = document.querySelector<HTMLElement>(".person-activity-hovercard")!;
    expect(
      offlineCard.querySelector(".person-activity-card__status--offline")?.textContent?.trim(),
    ).toBe("Offline");
    expect(offlineCard.querySelector("dl")).toBeNull();
    const recent = offlineCard.querySelector("section")!;
    expect(recent.querySelector("h3")?.textContent).toBe("Recent sessions");
    expect(recent.querySelector("a")?.getAttribute("href")).toBe(`/chat/main/${ownerId}`);
    expect(offlineCard.querySelector("footer a")?.getAttribute("href")).toBe(
      `/activity/${ownerId}`,
    );
    bobButton.click();
    expect(document.querySelector(".person-activity-hovercard")).toBeNull();
    bobButton.focus();
    await vi.waitFor(() =>
      expect(document.querySelector(".person-activity-hovercard h2")?.textContent).toBe(ownerName),
    );
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

    gateway.publishEvent("presence", {
      presence: [self, { ...ada, lastInputSeconds: 600 }],
    });
    await sidebar.updateComplete;
    expect(dot()?.classList.contains("sidebar-session-group-presence--idle")).toBe(true);
    expect(dot()?.getAttribute("aria-label")).toBe("Idle");
    expect(personButton.getAttribute("aria-describedby")).toBe(dot()!.id);

    gateway.publishEvent("presence", { presence: [self, { ...ada, reason: "disconnect" }] });
    await sidebar.updateComplete;
    expect(dot()).toBeNull();
    expect(personButton.hasAttribute("aria-describedby")).toBe(false);
    expect(
      section("ada").querySelector(".sidebar-session-group-toggle__person")?.hasAttribute("title"),
    ).toBe(false);
  });

  it("shows only other online identities with active-first ordering and idle dimming", async () => {
    const client = { instanceId: "self-instance" } as GatewayBrowserClient;
    const gatewayHarness = createGatewayHarness(client);
    const { sidebar } = await mountSidebar(
      gatewayHarness.gateway,
      createSessions("main", ["agent:main:main"]),
    );
    sidebar.connected = true;
    const onNavigate = vi.fn();
    sidebar.onNavigate = onNavigate;

    expect(sidebar.querySelector(".sidebar-online")).toBeNull();
    gatewayHarness.publishEvent("presence", {
      presence: [
        {
          instanceId: "self-instance",
          user: { id: "self", name: "Self" },
          lastInputSeconds: 0,
          ts: 1,
        },
      ],
    });
    await sidebar.updateComplete;
    expect(sidebar.querySelector(".sidebar-online")).toBeNull();

    gatewayHarness.publishEvent("presence", {
      presence: [
        {
          instanceId: "self-instance",
          user: { id: "self", name: "Self" },
          lastInputSeconds: 0,
          ts: 1,
        },
        {
          instanceId: "zed-instance",
          user: { id: "zed", name: "Zed" },
          lastInputSeconds: 20,
          ts: 1,
        },
        {
          instanceId: "alice-instance",
          user: { id: "alice", identity: { type: "profile" as const, id: "alice" }, name: "Alice" },
          lastInputSeconds: 600,
          ts: 1,
        },
        {
          instanceId: "bob-instance",
          user: { id: "bob", name: "Bob" },
          ts: 1,
        },
      ],
    });

    await vi.waitFor(() => {
      const rows = [...sidebar.querySelectorAll<HTMLElement>(".sidebar-online__person")];
      expect(
        rows.map((row) => row.querySelector(".sidebar-online__person-name")?.textContent?.trim()),
      ).toEqual(["Bob", "Zed", "Alice"]);
      expect(rows.map((row) => row.classList.contains("sidebar-online__person--away"))).toEqual([
        false,
        false,
        true,
      ]);
    });
    expect(sidebar.querySelector('[data-online-user-id="self"]')).toBeNull();

    const onlineToggle = sidebar.querySelector<HTMLButtonElement>(
      '.sidebar-online button[aria-label="Online"]',
    );
    expect(onlineToggle?.getAttribute("aria-expanded")).toBe("true");
    onlineToggle?.click();
    await sidebar.updateComplete;
    expect(onlineToggle?.getAttribute("aria-expanded")).toBe("false");
    expect(sidebar.querySelectorAll(".sidebar-online__person")).toHaveLength(0);
    expect(localStorage.getItem("openclaw:sidebar:sessions:collapsed-sections")).toBe(
      JSON.stringify(["online"]),
    );

    onlineToggle?.click();
    await sidebar.updateComplete;
    expect(sidebar.querySelectorAll(".sidebar-online__person")).toHaveLength(3);

    const aliceRow = sidebar.querySelector<HTMLAnchorElement>('[data-online-user-id="alice"]')!;
    aliceRow.click();
    await vi.dynamicImportSettled();
    expect(onNavigate).toHaveBeenCalledWith("activity", {
      href: "/activity/alice",
      pathname: "/activity/alice",
      search: "",
    });
    expect(aliceRow.tagName).toBe("A");
    expect(aliceRow.getAttribute("href")).toBe("/activity/alice");
    expect(aliceRow.closest(".sidebar-online__row")?.querySelectorAll("a, button")).toHaveLength(1);
    expect(document.querySelector(".person-activity-hovercard")).toBeNull();

    aliceRow.focus();
    await vi.dynamicImportSettled();
    await vi.waitFor(() =>
      expect(document.querySelector(".person-activity-hovercard")).not.toBeNull(),
    );
    aliceRow.querySelector<HTMLElement>(".sidebar-online__person-name")!.click();
    await vi.dynamicImportSettled();
    expect(onNavigate).toHaveBeenCalledTimes(2);
    expect(document.querySelector(".person-activity-hovercard")).toBeNull();

    const bobRow = sidebar.querySelector<HTMLButtonElement>('[data-online-user-id="bob"]')!;
    expect(bobRow.tagName).toBe("BUTTON");
    bobRow.click();
    await vi.waitFor(() =>
      expect(document.querySelector(".person-activity-hovercard h2")?.textContent).toBe("Bob"),
    );
    expect(onNavigate).toHaveBeenCalledTimes(2);
  });

  it("projects only visible sessions and reported facts without guessing timing or devices", async () => {
    const gateway = createGatewayHarness({ instanceId: "self" } as GatewayBrowserClient);
    const sessions = createSessionsHarness("research", [
      "watched",
      "global",
      "agent:research:ambiguous",
      "agent:research:robot",
      ...[1, 2, 3, 4].map((n) => `agent:research:recent-${n}`),
    ]);
    const result = sessions.sessions.state.result!;
    result.sessions.forEach((row, index) => {
      row.label = row.key === "global" ? "Research global" : `Visible ${index}`;
      row.updatedAt = Date.now() - index * 60_000;
      if (index === 2) {
        row.participants = [{ identity: { type: "profile", id: "alice" }, label: "Alice" }];
      }
      if (index === 3) {
        row.createdActor = { type: "agent", id: "alice" };
      }
      if (index >= 4) {
        row.owner = {
          actor: { type: "human", id: "alice", identity: { type: "profile", id: "alice" } },
        };
      }
    });
    sessions.publishList({ result });
    const { sidebar } = await mountSidebar(gateway.gateway, sessions.sessions);
    sidebar.connected = true;
    gateway.publishEvent("presence", {
      presence: [1, 2, 3].map((tab) => ({
        ts: Date.now() - 500_000,
        lastInputSeconds: 3,
        instanceId: `private-tab-${tab}`,
        ip: "192.0.2.12",
        host: "internal-host",
        deviceFamily: tab === 3 ? "iPhone" : "Mac",
        platform: tab === 3 ? "iOS" : "macOS",
        mode: "webchat",
        timeZone: "Europe/Paris",
        user: { id: "alice", identity: { type: "profile" as const, id: "alice" }, name: "Alice" },
        watchedSessions: [
          "AGENT:research:watched",
          "agent:research:watched",
          "agent:private:secret-title",
          "global",
        ],
      })),
    });
    await sidebar.updateComplete;
    sidebar.querySelector<HTMLElement>(".sidebar-online__person")!.focus();
    // Focus loads its interaction owner before the card can render.
    await vi.dynamicImportSettled();
    await vi.waitFor(() =>
      expect(document.querySelector(".person-activity-hovercard")).not.toBeNull(),
    );
    const card = document.querySelector<HTMLElement>(".person-activity-hovercard")!;
    expect(card.querySelectorAll("dt")).toHaveLength(2);
    expect(card.querySelector(".person-activity-card__status")?.textContent?.trim()).toBe("Online");
    const facts = card.querySelectorAll("dd");
    expect([...facts[0]!.querySelectorAll("span")].map((node) => node.textContent)).toEqual([
      "Mac · macOS · Control UI",
      "iPhone · iOS · Control UI",
    ]);
    expect(facts[0]?.querySelector("small")?.textContent).toBe("Reported time zone: Europe/Paris");
    expect(facts[1]?.textContent?.trim()).toBe("Not observed yet");
    const sections = card.querySelectorAll("section");
    expect(sections[0]?.querySelectorAll("a")).toHaveLength(1);
    expect(sections[0]?.textContent).toContain("Visible 0");
    expect(sections[0]?.querySelector("a")?.getAttribute("href")).toBe("/chat/research/watched");
    expect(sections[1]?.querySelectorAll("a")).toHaveLength(3);
    expect(sections[1]?.textContent).not.toContain("Session updated");
    expect(sections[1]?.querySelectorAll(".person-activity-card__session-age")).toHaveLength(3);
    for (const hidden of [
      "secret-title",
      "private-tab",
      "internal-host",
      "192.0.2.12",
      "Research global",
      "Visible 2",
      "Visible 3",
      "Visible 7",
    ]) {
      expect(card.outerHTML).not.toContain(hidden);
    }
    expect(card.querySelectorAll("[data-viewer-id]")).toHaveLength(0);
  });

  it("keeps the active identity and focused session link across presence reordering", async () => {
    const gateway = createGatewayHarness({ instanceId: "self" } as GatewayBrowserClient);
    const sessions = createSessionsHarness("main", ["agent:main:work"]);
    const result = sessions.sessions.state.result!;
    sessions.publishList({
      result: {
        ...result,
        sessions: result.sessions.map((row) => ({
          ...row,
          createdActor: {
            type: "human" as const,
            id: "alice",
            identity: { type: "profile" as const, id: "alice" },
          },
        })),
      },
    });
    const { sidebar } = await mountSidebar(gateway.gateway, sessions.sessions);
    sidebar.connected = true;
    const now = Date.now();
    const alice = {
      ts: now,
      user: { id: "alice", identity: { type: "profile" as const, id: "alice" }, name: "Alice" },
      watchedSessions: ["agent:main:work"],
      onlineSince: now - 60_000,
      lastActivityAt: now - 10_000,
      lastInputSeconds: 0,
    };
    const bob = { ts: now, user: { id: "bob", name: "Bob" }, lastInputSeconds: 0 };
    gateway.publishEvent("presence", { presence: [alice, bob] });
    await sidebar.updateComplete;
    const button = sidebar.querySelector<HTMLAnchorElement>('[data-online-user-id="alice"]')!;
    button.focus();
    await vi.dynamicImportSettled();
    await vi.waitFor(() =>
      expect(document.querySelector(".person-activity-hovercard")).not.toBeNull(),
    );
    const card = document.querySelector<HTMLElement>(".person-activity-hovercard")!;
    await vi.waitFor(() =>
      expect(card.querySelector(".person-activity-card__status")?.textContent?.trim()).toBe(
        "Online for 1m",
      ),
    );
    const sessionLink = card.querySelector<HTMLAnchorElement>(".person-activity-card__session")!;
    sessionLink.focus();
    gateway.publishEvent("presence", {
      presence: [{ ...alice, lastInputSeconds: 600, lastActivityAt: now }, bob],
    });
    await sidebar.updateComplete;
    expect(sidebar.querySelector('[data-online-user-id="alice"]')).toBe(button);
    expect(
      sidebar.querySelector(".sidebar-online__person")?.getAttribute("data-online-user-id"),
    ).toBe("bob");
    expect(card.querySelector("h2")?.textContent).toBe("Alice");
    expect(document.activeElement).toBe(sessionLink);
    expect(card.querySelector("time")?.getAttribute("datetime")).toBe(
      new Date(alice.onlineSince).toISOString(),
    );
    gateway.publishEvent("presence", { presence: [{ ...alice, watchedSessions: [] }, bob] });
    await sidebar.updateComplete;
    expect([...card.querySelectorAll("h3")].map((heading) => heading.textContent)).toEqual([
      "Recent sessions",
    ]);
    expect(document.activeElement?.getAttribute("href")).toBe(sessionLink.getAttribute("href"));
    expect(document.activeElement?.closest("section")?.querySelector("h3")?.textContent).toBe(
      "Recent sessions",
    );
    sessions.publishList({ result: { ...result, sessions: [], count: 0 } });
    await sidebar.updateComplete;
    expect(document.activeElement).toBe(button);
    button.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(document.querySelector(".person-activity-hovercard")).toBeNull();
    expect(document.activeElement).toBe(button);
    expect(button.getAttribute("aria-expanded")).toBe("false");
  });

  it.each(["disconnect", "switch", "route", "collapse", "shell", "remove", "teardown"] as const)(
    "dismisses and releases card timers on %s",
    async (reason) => {
      const gateway = createGatewayHarness({ instanceId: "self" } as GatewayBrowserClient);
      const { sidebar, provider } = await mountSidebar(
        gateway.gateway,
        createSessions("main", ["agent:main:work"]),
      );
      sidebar.connected = true;
      const person = {
        ts: Date.now(),
        user: { id: "alice", identity: { type: "profile" as const, id: "alice" }, name: "Alice" },
        onlineSince: Date.now() - 90_000,
      };
      gateway.publishEvent("presence", {
        presence: [person],
      });
      await sidebar.updateComplete;
      vi.useFakeTimers();
      sidebar.querySelector<HTMLElement>(".sidebar-online__person")!.focus();
      await vi.dynamicImportSettled();
      await vi.waitFor(() =>
        expect(document.querySelector("openclaw-elapsed-time")?.textContent).toBeTruthy(),
      );
      const elapsed = document.querySelector<LitElement>("openclaw-elapsed-time")!;
      await elapsed.updateComplete;
      const elapsedBeforeDismissal = elapsed.textContent;
      if (reason === "disconnect") {
        gateway.publish({ phase: "reconnecting" });
      }
      if (reason === "switch") {
        gateway.publish({ client: { instanceId: "replacement" } as GatewayBrowserClient });
      }
      if (reason === "route") {
        sidebar.activeRouteId = "activity";
      }
      if (reason === "shell") {
        sidebar.dismissTransientMenus();
      }
      if (reason === "collapse") {
        sidebar
          .querySelector<HTMLButtonElement>('.sidebar-online button[aria-label="Online"]')!
          .click();
      }
      if (reason === "remove") {
        gateway.publishEvent("presence", { presence: [{ ...person, reason: "disconnect" }] });
      }
      if (reason === "teardown") {
        provider.remove();
      }
      await sidebar.updateComplete;
      await vi.waitFor(() =>
        expect(document.querySelector(".person-activity-hovercard")).toBeNull(),
      );
      await vi.advanceTimersByTimeAsync(1_000);
      await elapsed.updateComplete;
      expect(elapsed.textContent).toBe(elapsedBeforeDismissal);
      if (reason === "remove") {
        expect(sidebar.querySelector(".sidebar-online")).toBeNull();
        const returned = { ...person, ts: Date.now(), onlineSince: Date.now() };
        gateway.publishEvent("presence", {
          presence: [{ ...person, reason: "disconnect" }, returned],
        });
        await sidebar.updateComplete;
        sidebar.querySelector<HTMLElement>(".sidebar-online__person")!.focus();
        await vi.waitFor(() =>
          expect(
            document.querySelector(".person-activity-hovercard time")?.getAttribute("datetime"),
          ).toBe(new Date(returned.onlineSince).toISOString()),
        );
        expect(document.querySelector(".person-activity-hovercard h2")?.textContent).toBe("Alice");
      }
    },
  );

  it("restores the collapsed online section", async () => {
    localStorage.setItem(
      "openclaw:sidebar:sessions:collapsed-sections",
      JSON.stringify(["online"]),
    );
    const gatewayHarness = createGatewayHarness({
      instanceId: "self-instance",
    } as GatewayBrowserClient);
    const { sidebar } = await mountSidebar(
      gatewayHarness.gateway,
      createSessions("main", ["agent:main:main"]),
    );

    gatewayHarness.publishEvent("presence", {
      presence: [
        { instanceId: "self-instance", user: { id: "self", name: "Self" } },
        {
          instanceId: "alice-instance",
          user: { id: "alice", identity: { type: "profile" as const, id: "alice" }, name: "Alice" },
        },
        { instanceId: "bob-instance", user: { id: "bob", name: "Bob" } },
        { instanceId: "carol-instance", user: { id: "carol", name: "Carol" } },
        { instanceId: "dave-instance", user: { id: "dave", name: "Dave" } },
      ],
    });
    await sidebar.updateComplete;

    const onlineToggle = sidebar.querySelector<HTMLButtonElement>(
      '.sidebar-online button[aria-label="Online"]',
    );
    expect(onlineToggle?.getAttribute("aria-expanded")).toBe("false");
    expect(sidebar.querySelector(".sidebar-online__person")).toBeNull();
    const facepile = sidebar.querySelector<HTMLElement>(".sidebar-online openclaw-viewer-facepile");
    await (facepile as { updateComplete?: Promise<unknown> } | null)?.updateComplete;
    expect(facepile?.querySelector(".viewer-facepile")?.getAttribute("data-viewer-count")).toBe(
      "4",
    );
    expect(facepile?.querySelectorAll("[data-viewer-id]")).toHaveLength(2);
    expect(facepile?.querySelector(".viewer-avatar--overflow")?.textContent).toContain("+2");
  });

  it("renders the self user's avatar route in the footer identity chip", async () => {
    const client = { instanceId: "self-instance" } as GatewayBrowserClient;
    const gatewayHarness = createGatewayHarness(client);
    const { sidebar } = await mountSidebar(
      gatewayHarness.gateway,
      createSessions("main", ["agent:main:main"]),
    );
    sidebar.connected = true;

    gatewayHarness.publishEvent("presence", {
      presence: [
        {
          instanceId: "self-instance",
          user: {
            id: "00-self",
            email: "test@example.com",
            name: "Self User",
            avatarUrl: "/api/users/00-self/avatar?v=7",
          },
        },
      ],
    });

    await vi.waitFor(() => {
      const avatar = sidebar.querySelector<HTMLImageElement>(
        ".sidebar-identity-card openclaw-viewer-avatar img",
      );
      expect(avatar?.getAttribute("src")).toBe("/api/users/00-self/avatar?v=7");
    });
  });

  it("groups identified viewers for session rows and keeps the footer identity-only", async () => {
    const client = { instanceId: "self-instance" } as GatewayBrowserClient;
    const gatewayHarness = createGatewayHarness(client);
    const { sidebar } = await mountSidebar(
      gatewayHarness.gateway,
      createSessions("main", ["agent:main:main", "agent:main:work"]),
    );
    sidebar.connected = true;
    gatewayHarness.publishEvent("presence", {
      presence: [
        {
          instanceId: "self-instance",
          user: {
            id: "00-self",
            name: "Self User",
            avatarUrl: "/api/users/00-self/avatar?v=1",
          },
          watchedSessions: ["agent:main:work"],
        },
        {
          instanceId: "alice-1",
          user: {
            id: "alice",
            identity: { type: "profile", id: "alice" },
            name: "Alice",
            avatarUrl: "/api/users/alice/avatar",
          },
          watchedSessions: ["agent:main:work"],
        },
        {
          instanceId: "alice-2",
          user: { id: "alice", identity: { type: "profile" as const, id: "alice" }, name: "Alice" },
          watchedSessions: ["agent:main:main"],
        },
        {
          instanceId: "bob-1",
          user: { id: "bob", email: "bob@example.test" },
          watchedSessions: ["agent:main:work"],
        },
        ...["carol", "dave", "erin", "frank"].map((id) => ({
          instanceId: `${id}-1`,
          user: { id, name: id[0]?.toUpperCase() + id.slice(1) },
          watchedSessions: ["agent:main:work"],
        })),
        {
          instanceId: "anonymous-1",
          watchedSessions: ["agent:main:work"],
        },
        {
          instanceId: "offline-1",
          reason: "disconnect",
          user: { id: "offline", name: "Offline User" },
          watchedSessions: ["agent:main:work"],
        },
      ],
    });
    await sidebar.updateComplete;
    gatewayHarness.publish({
      selfUser: {
        id: "00-self",
        name: "Self User",
        avatarUrl: "/api/users/00-self/avatar?v=1",
      },
    });
    await sidebar.updateComplete;

    const sessionFacepile = sidebar.querySelector<HTMLElement>(
      '[data-session-key="agent:main:work"] openclaw-viewer-facepile',
    );
    await (sessionFacepile as { updateComplete?: Promise<unknown> } | null)?.updateComplete;
    expect(
      sessionFacepile?.querySelector(".viewer-facepile")?.getAttribute("data-viewer-count"),
    ).toBe("6");
    expect(
      [...(sessionFacepile?.querySelectorAll<HTMLElement>("[data-viewer-id]") ?? [])].map(
        (avatar) => avatar.dataset.viewerId,
      ),
    ).toEqual(["alice", "bob", "carol"]);
    expect(sessionFacepile?.querySelector(".viewer-avatar--overflow")?.textContent).toContain("+3");
    expect(sessionFacepile?.querySelector('[data-viewer-id="alice"] img')).not.toBeNull();
    expect(
      [...(sessionFacepile?.querySelectorAll("openclaw-tooltip") ?? [])].map(
        (tooltip) => (tooltip as HTMLElement & { content?: string }).content,
      ),
    ).toEqual(["Alice", "bob@example.test", "Carol", "Dave\nErin\nFrank"]);

    const identityCard = sidebar.querySelector<HTMLButtonElement>(".sidebar-identity-card");
    expect(identityCard?.querySelector(".sidebar-identity-card__name")?.textContent?.trim()).toBe(
      "Self User",
    );
    expect(identityCard?.querySelector('[data-viewer-id="00-self"]')).not.toBeNull();

    const avatar = identityCard?.querySelector<HTMLImageElement>("openclaw-viewer-avatar img");
    expect(avatar?.getAttribute("src")).toBe("/api/users/00-self/avatar?v=1");
    const footer = sidebar.querySelector(".sidebar-footer-bar");
    expect(footer?.querySelector("openclaw-viewer-facepile")).toBeNull();
    expect(footer?.querySelector("openclaw-sidebar-build-chip")).toBeNull();
    expect(footer?.querySelector(".sidebar-brand__logo-slot")).toBeNull();
    gatewayHarness.gateway.updateSelfUser?.({
      name: "Augusta Ada",
      avatarUrl: "/api/users/00-self/avatar?v=4",
    });
    await sidebar.updateComplete;

    expect(identityCard?.querySelector(".sidebar-identity-card__name")?.textContent?.trim()).toBe(
      "Augusta Ada",
    );
    expect(avatar?.getAttribute("src")).toBe("/api/users/00-self/avatar?v=4");

    sidebar.connected = false;
    await sidebar.updateComplete;
    expect(sidebar.querySelector(".sidebar-identity-card__name")?.textContent?.trim()).toBe(
      "Augusta Ada",
    );
  });

  it.each([
    undefined,
    { id: "owner-profile", identity: { type: "profile" as const, id: "owner-profile" } },
  ])("renders an Owner fallback without a name or email (%j)", async (user) => {
    const client = { instanceId: "anonymous-self" } as GatewayBrowserClient;
    const gatewayHarness = createGatewayHarness(client);
    const { sidebar } = await mountSidebar(
      gatewayHarness.gateway,
      createSessions("main", ["agent:main:main"]),
    );

    gatewayHarness.publishEvent("presence", {
      presence: [
        { instanceId: "anonymous-self", user, watchedSessions: ["agent:main:main"] },
        {
          instanceId: "alice",
          user: { id: "alice", identity: { type: "profile" as const, id: "alice" }, name: "Alice" },
        },
      ],
    });
    await sidebar.updateComplete;

    const identityCard = sidebar.querySelector(".sidebar-identity-card");
    expect(identityCard?.querySelector(".sidebar-identity-card__name")?.textContent?.trim()).toBe(
      "Owner",
    );
    expect(
      identityCard?.querySelector(`[data-viewer-id="${user?.id ?? "owner"}"]`)?.textContent,
    ).toContain("O");
  });
});
