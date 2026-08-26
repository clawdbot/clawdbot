import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { createGatewayHarness, createSessions, mountSidebar } from "../app-sidebar.ts";
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

    sidebar.querySelector<HTMLAnchorElement>('[data-online-user-id="alice"]')?.click();
    expect(onNavigate).toHaveBeenCalledWith("activity", {
      pathname: "/activity",
      search: "?person=alice",
    });
  });

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
