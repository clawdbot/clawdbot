import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationOverlays } from "../../app/overlays-types.ts";
import {
  dismissSidebarAttention,
  resolveUpdateAttentionDismissal,
} from "../../components/sidebar-attention-dismissals.ts";
import { createGatewayHarness, createSessions, mountSidebar } from "../app-sidebar.ts";
import "../../components/app-sidebar.ts";

describe("AppSidebar footer identity menu", () => {
  it("opens Profile from the Owner header without a self user", async () => {
    const { sidebar } = await mountSidebar(
      createGatewayHarness({ instanceId: "self-instance" } as GatewayBrowserClient).gateway,
      createSessions("main", ["agent:main:main"]),
    );
    sidebar.onNavigate = vi.fn();
    sidebar.querySelector<HTMLButtonElement>(".sidebar-identity-card")?.click();
    await sidebar.updateComplete;

    const menu = sidebar.querySelector<HTMLElement>(".sidebar-identity-menu");
    const header = menu?.querySelector<HTMLElement>('wa-dropdown-item[value="command:profile"]');
    expect(header?.querySelector(".sidebar-identity-menu__name")?.textContent?.trim()).toBe(
      "Owner",
    );
    expect(header?.querySelector('[data-viewer-id="owner"]')?.textContent).toContain("O");
    menu?.dispatchEvent(new CustomEvent("wa-select", { detail: { item: header }, bubbles: true }));
    await sidebar.updateComplete;
    expect(sidebar.onNavigate).toHaveBeenCalledWith("profile", {
      hash: "#settings-profile-identity",
    });
  });

  it("keeps a dismissed update as a discreet account-menu chip", async () => {
    const gatewayHarness = createGatewayHarness({
      instanceId: "self-instance",
    } as GatewayBrowserClient);
    gatewayHarness.publish({
      hello: {
        ...gatewayHarness.gateway.snapshot.hello!,
        server: {
          ...gatewayHarness.gateway.snapshot.hello!.server,
          bootId: "boot-a",
        },
      },
    });
    const { sidebar, context } = await mountSidebar(
      gatewayHarness.gateway,
      createSessions("main", ["agent:main:main"]),
    );
    (context.overlays as unknown as { snapshot: ApplicationOverlays["snapshot"] }).snapshot = {
      ...context.overlays.snapshot,
      updateAvailable: {
        currentVersion: "2026.8.1",
        latestVersion: "2026.8.2",
        channel: "latest",
      },
      updateSchedule: null,
      updateStatusBanner: null,
    };
    const dismissal = resolveUpdateAttentionDismissal({
      gatewayBootId: "boot-a",
      updateAvailable: context.overlays.snapshot.updateAvailable,
    });
    if (!dismissal) {
      throw new Error("expected update dismissal fact");
    }
    dismissSidebarAttention("ws://gateway.test", dismissal);
    sidebar.requestUpdate();
    await sidebar.updateComplete;

    sidebar.querySelector<HTMLButtonElement>(".sidebar-identity-card")?.click();
    await sidebar.updateComplete;
    const buildChip = sidebar.querySelector<HTMLElement>("openclaw-sidebar-build-chip");
    await (buildChip as (HTMLElement & { updateComplete?: Promise<unknown> }) | null)
      ?.updateComplete;

    expect(
      (buildChip as (HTMLElement & { updateAttentionDismissed?: boolean }) | null)
        ?.updateAttentionDismissed,
    ).toBe(true);
    expect(buildChip?.querySelector(".sidebar-footer-build__update")?.textContent?.trim()).toBe(
      "Update available",
    );

    (context.overlays as unknown as { snapshot: ApplicationOverlays["snapshot"] }).snapshot = {
      ...context.overlays.snapshot,
      updateAvailable: {
        currentVersion: "2026.8.2",
        latestVersion: "2026.8.2",
        channel: "latest",
      },
    };
    sidebar.requestUpdate();
    await sidebar.updateComplete;
    expect(
      (buildChip as HTMLElement & { updateAttentionDismissed?: boolean }).updateAttentionDismissed,
    ).toBe(false);
    expect(buildChip?.querySelector(".sidebar-footer-build__update")).toBeNull();
  });

  it("owns account utilities, restores focus, and routes Profile", async () => {
    const fullName = "Ada Lovelace With A Deliberately Long Display Name";
    const gatewayHarness = createGatewayHarness({
      instanceId: "self-instance",
    } as GatewayBrowserClient);
    const { sidebar } = await mountSidebar(
      gatewayHarness.gateway,
      createSessions("main", ["agent:main:main"]),
    );
    const onNavigate = vi.fn();
    sidebar.connected = true;
    sidebar.canPairDevice = false;
    sidebar.onNavigate = onNavigate;
    gatewayHarness.publishEvent("presence", {
      presence: [
        {
          instanceId: "self-instance",
          user: {
            id: "self",
            name: fullName,
            email: "ada.with.a.deliberately.long.address@example.test",
            avatarUrl: "/api/users/self/avatar?v=1",
          },
        },
      ],
    });
    await sidebar.updateComplete;

    const identity = sidebar.querySelector<HTMLButtonElement>(".sidebar-identity-card");
    expect(identity?.getAttribute("aria-haspopup")).toBe("menu");
    vi.spyOn(identity!, "getBoundingClientRect").mockReturnValue({
      left: 12,
      right: 224,
      top: 700,
      width: 212,
    } as DOMRect);
    identity?.click();
    await sidebar.updateComplete;

    const menu = sidebar.querySelector<HTMLElement>(".sidebar-identity-menu");
    expect(identity?.getAttribute("aria-expanded")).toBe("true");
    expect(
      [...(menu?.children ?? [])]
        .filter((element) => element.localName === "wa-dropdown-item")
        .map((element) => element.getAttribute("value")),
    ).toEqual([
      "command:profile",
      "command:settings",
      "command:usage",
      "command:pair-mobile",
      "command:apps",
      "command:debug-overlay",
      "command:help",
    ]);
    const footerName = identity?.querySelector(".sidebar-identity-card__name");
    const menuName = menu?.querySelector(".sidebar-identity-menu__name");
    expect(footerName?.textContent?.trim()).toBe(fullName);
    expect(footerName?.getAttribute("title")).toBe(fullName);
    expect(menuName?.textContent?.trim()).toBe(fullName);
    expect(menuName?.getAttribute("title")).toBe(fullName);
    const menuEmail = menu?.querySelector(".sidebar-identity-menu__email");
    expect(menuEmail?.textContent?.trim()).toBe(
      "ada.with.a.deliberately.long.address@example.test",
    );
    expect(menuEmail?.getAttribute("title")).toBe(
      "ada.with.a.deliberately.long.address@example.test",
    );
    expect(menu?.querySelector(".sidebar-identity-menu__avatar")?.getAttribute("aria-hidden")).toBe(
      "true",
    );
    expect(menu?.querySelector('[data-viewer-id="self"] img')?.getAttribute("src")).toBe(
      "/api/users/self/avatar?v=1",
    );
    expect(identity?.querySelector('[data-viewer-id="self"] img')?.getAttribute("src")).toBe(
      "/api/users/self/avatar?v=1",
    );
    expect(
      menu
        ?.querySelector('wa-dropdown-item[value="command:settings"] .session-menu__shortcut')
        ?.textContent?.trim(),
    ).toMatch(/^(⌘⇧,|Ctrl\+Shift\+,)$/u);
    expect(menu?.style.getPropertyValue("--sidebar-identity-menu-min-width")).toBe("212px");
    expect(menu?.querySelector(".sidebar-pair-mobile")?.hasAttribute("disabled")).toBe(true);
    expect(menu?.querySelector("openclaw-sidebar-build-chip")).not.toBeNull();
    expect(
      (menu?.querySelector("openclaw-sidebar-build-chip") as { variant?: string } | null)?.variant,
    ).toBe("identity");
    expect(menu?.querySelector("openclaw-theme-mode-toggle")).not.toBeNull();
    expect(menu?.textContent).not.toContain("Recent activity");
    expect(menu?.querySelectorAll(':scope > [role="separator"]')).toHaveLength(4);
    expect(identity?.querySelector(".sidebar-identity-card__more")).toBeNull();
    expect(identity?.querySelector(".sidebar-identity-card__chevron")).toBeNull();

    const helpRow = menu?.querySelector<HTMLElement>(".sidebar-identity-menu__help");
    await (helpRow as (HTMLElement & { updateComplete?: Promise<unknown> }) | null)?.updateComplete;
    expect(helpRow?.getAttribute("aria-haspopup")).toBe("menu");
    expect(
      [...(helpRow?.querySelectorAll('wa-dropdown-item[slot="submenu"] a[href]') ?? [])].map(
        (link) => link.getAttribute("href"),
      ),
    ).toEqual([
      "https://docs.openclaw.ai",
      "https://docs.openclaw.ai/help",
      "https://discord.gg/clawd",
      "https://docs.openclaw.ai/releases",
    ]);

    menu?.querySelector<HTMLElement>('wa-dropdown-item[value="command:profile"]')?.focus();
    menu?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    menu?.dispatchEvent(new CustomEvent("wa-after-hide"));
    await sidebar.updateComplete;
    expect(sidebar.querySelector(".sidebar-identity-menu")).toBeNull();
    expect(document.activeElement).toBe(identity);

    identity?.click();
    await sidebar.updateComplete;
    const reopened = sidebar.querySelector<HTMLElement>(".sidebar-identity-menu");
    const profile = reopened?.querySelector<HTMLElement>(
      'wa-dropdown-item[value="command:profile"]',
    );
    reopened?.dispatchEvent(
      new CustomEvent("wa-select", { detail: { item: profile }, bubbles: true }),
    );
    await sidebar.updateComplete;
    expect(onNavigate).toHaveBeenCalledWith("profile", { hash: "#settings-profile-identity" });
    expect(sidebar.querySelector(".sidebar-identity-menu")).toBeNull();
  });

  it.each([false, true])(
    "traverses footer controls without losing the active menu item (offline: %s)",
    async (offline) => {
      const { sidebar } = await mountSidebar(
        createGatewayHarness({ instanceId: "self-instance" } as GatewayBrowserClient).gateway,
        createSessions("main", ["agent:main:main"]),
      );
      sidebar.connected = true;
      sidebar.canPairDevice = false;
      sidebar.offline = offline;
      await sidebar.updateComplete;

      const identity = sidebar.querySelector<HTMLButtonElement>(".sidebar-identity-card");
      identity?.click();
      await sidebar.updateComplete;

      const menu = sidebar.querySelector<HTMLElement>(".sidebar-identity-menu");
      const items = Array.from(menu?.children ?? []).filter(
        (item): item is HTMLElement & { active: boolean } =>
          item instanceof HTMLElement &&
          item.localName === "wa-dropdown-item" &&
          !item.hasAttribute("disabled"),
      );
      const lastItem = items.at(-1);
      const theme = menu?.querySelector<HTMLButtonElement>(".theme-mode-toggle");
      const build = document.createElement("a");
      build.href = "#build";
      menu?.querySelector(".sidebar-mode-switch")?.insertAdjacentElement("beforebegin", build);

      const arrow = (target: HTMLElement | undefined, key: "ArrowDown" | "ArrowUp") => {
        target?.dispatchEvent(
          new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
        );
      };
      items.forEach((item) => (item.active = item === lastItem));
      lastItem?.focus();
      arrow(lastItem, "ArrowDown");
      expect(document.activeElement).toBe(build);
      arrow(build, "ArrowDown");
      expect(document.activeElement).toBe(theme);
      arrow(theme ?? undefined, "ArrowUp");
      expect(document.activeElement).toBe(build);
      arrow(build, "ArrowUp");
      expect(document.activeElement).toBe(lastItem);
      expect(lastItem?.active).toBe(true);

      build.remove();
      arrow(lastItem, "ArrowDown");
      expect(document.activeElement).toBe(theme);
      arrow(theme ?? undefined, "ArrowUp");
      expect(document.activeElement).toBe(lastItem);

      items[0]?.focus();
      items.forEach((item) => (item.active = item === items[0]));
      arrow(items[0], "ArrowUp");
      expect(document.activeElement).toBe(theme);
      arrow(theme ?? undefined, "ArrowDown");
      expect(document.activeElement).toBe(items[0]);
    },
  );
});
