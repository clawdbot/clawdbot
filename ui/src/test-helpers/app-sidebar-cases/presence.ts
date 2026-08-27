import type { LitElement } from "lit";
import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import {
  createGatewayHarness,
  createSessions,
  createSessionsHarness,
  mountSidebar,
} from "../app-sidebar.ts";
import "../../components/app-sidebar.ts";

await import("../../components/viewer-facepile.ts");

describe("AppSidebar viewer presence", () => {
  it("shows only other online identities with active-first ordering and idle dimming", async () => {
    const client = { instanceId: "self-instance" } as GatewayBrowserClient;
    const gatewayHarness = createGatewayHarness(client);
    const { sidebar } = await mountSidebar(
      gatewayHarness.gateway,
      createSessions("main", ["agent:main:main"]),
    );
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
          user: { id: "alice", name: "Alice" },
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

    const aliceLink = sidebar.querySelector<HTMLAnchorElement>('[data-online-user-id="alice"]')!;
    for (const options of [
      { ctrlKey: true },
      { metaKey: true },
      { shiftKey: true },
      { button: 1 },
    ]) {
      const click = new MouseEvent("click", { ...options, bubbles: true, cancelable: true });
      let intercepted = false;
      aliceLink.addEventListener(
        "click",
        (event) => {
          intercepted = event.defaultPrevented;
          event.preventDefault(); // Keep jsdom from attempting a new browsing context.
        },
        { once: true },
      );
      aliceLink.dispatchEvent(click);
      expect(intercepted).toBe(false);
    }
    expect(onNavigate).not.toHaveBeenCalled();
    aliceLink.click();
    expect(onNavigate).toHaveBeenCalledWith("activity", {
      href: "/activity?person=alice",
      pathname: "/activity",
      search: "?person=alice",
    });
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
        row.participants = [{ type: "human", id: "alice", label: "Alice" }];
      }
      if (index === 3) {
        row.createdActor = { type: "agent", id: "alice" };
      }
      if (index >= 4) {
        row.owner = { actor: { type: "human", id: "alice" } };
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
        user: { id: "alice", name: "Alice" },
        watchedSessions: [
          "AGENT:research:watched",
          "agent:research:watched",
          "agent:private:secret-title",
          "global",
        ],
      })),
    });
    await sidebar.updateComplete;
    sidebar.querySelector<HTMLButtonElement>(".sidebar-online__details")!.click();
    await vi.waitFor(() =>
      expect(document.querySelector(".person-activity-hovercard")).not.toBeNull(),
    );
    const card = document.querySelector<HTMLElement>(".person-activity-hovercard")!;
    expect(card.querySelectorAll("dt")).toHaveLength(3);
    const facts = card.querySelectorAll("dd");
    expect(facts[0]?.textContent?.trim()).toBe("Not observed yet");
    expect([...facts[1]!.querySelectorAll("span")].map((node) => node.textContent)).toEqual([
      "Mac · macOS · Control UI",
      "iPhone · iOS · Control UI",
    ]);
    expect(facts[1]?.querySelector("small")?.textContent).toBe("Reported time zone: Europe/Paris");
    expect(facts[2]?.textContent?.trim()).toBe("Not observed yet");
    const sections = card.querySelectorAll("section");
    expect(sections[0]?.querySelectorAll("a")).toHaveLength(1);
    expect(sections[0]?.textContent).toContain("Visible 0");
    expect(sections[0]?.querySelector("a")?.getAttribute("href")).toBe("/chat/research/watched");
    expect(sections[1]?.querySelectorAll("a")).toHaveLength(3);
    expect(sections[1]?.textContent).toContain("Session updated");
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
          createdActor: { type: "human" as const, id: "alice" },
        })),
      },
    });
    const { sidebar } = await mountSidebar(gateway.gateway, sessions.sessions);
    sidebar.connected = true;
    const now = Date.now();
    const alice = {
      ts: now,
      user: { id: "alice", name: "Alice" },
      watchedSessions: ["agent:main:work"],
      onlineSince: now - 60_000,
      lastActivityAt: now - 10_000,
      lastInputSeconds: 0,
    };
    const bob = { ts: now, user: { id: "bob", name: "Bob" }, lastInputSeconds: 0 };
    gateway.publishEvent("presence", { presence: [alice, bob] });
    await sidebar.updateComplete;
    const aliceLink = sidebar.querySelector<HTMLAnchorElement>('[data-online-user-id="alice"]')!;
    const button = aliceLink.parentElement!.querySelector<HTMLButtonElement>("button")!;
    button.click();
    await vi.waitFor(() =>
      expect(document.querySelector(".person-activity-hovercard")).not.toBeNull(),
    );
    const card = document.querySelector<HTMLElement>(".person-activity-hovercard")!;
    const sessionLink = card.querySelector<HTMLAnchorElement>(".person-activity-card__session")!;
    sessionLink.focus();
    gateway.publishEvent("presence", {
      presence: [{ ...alice, lastInputSeconds: 600, lastActivityAt: now }, bob],
    });
    await sidebar.updateComplete;
    expect(sidebar.querySelector('[data-online-user-id="alice"]')).toBe(aliceLink);
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
        user: { id: "alice", name: "Alice" },
        onlineSince: Date.now() - 90_000,
      };
      gateway.publishEvent("presence", {
        presence: [person],
      });
      await sidebar.updateComplete;
      vi.useFakeTimers();
      sidebar.querySelector<HTMLButtonElement>(".sidebar-online__details")!.click();
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
        sidebar.querySelector<HTMLButtonElement>(".sidebar-online__details")!.click();
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
        { instanceId: "alice-instance", user: { id: "alice", name: "Alice" } },
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
          user: { id: "alice", name: "Alice", avatarUrl: "/api/users/alice/avatar" },
          watchedSessions: ["agent:main:work"],
        },
        {
          instanceId: "alice-2",
          user: { id: "alice", name: "Alice" },
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

  it("renders an Account fallback for an unidentified connection", async () => {
    const client = { instanceId: "anonymous-self" } as GatewayBrowserClient;
    const gatewayHarness = createGatewayHarness(client);
    const { sidebar } = await mountSidebar(
      gatewayHarness.gateway,
      createSessions("main", ["agent:main:main"]),
    );

    gatewayHarness.publishEvent("presence", {
      presence: [
        { instanceId: "anonymous-self", watchedSessions: ["agent:main:main"] },
        { instanceId: "alice", user: { id: "alice", name: "Alice" } },
      ],
    });
    await sidebar.updateComplete;

    const identityCard = sidebar.querySelector(".sidebar-identity-card");
    expect(identityCard?.querySelector(".sidebar-identity-card__name")?.textContent?.trim()).toBe(
      "Account",
    );
    expect(identityCard?.querySelector('[data-viewer-id="account"]')?.textContent).toContain("A");
  });
});
