import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { createGatewayHarness, createSessions, mountSidebar } from "../app-sidebar.ts";
import "../../components/app-sidebar.ts";

describe("AppSidebar footer identity menu", () => {
  it("owns account utilities, restores focus, and routes Profile", async () => {
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
          user: { id: "self", name: "Ada", email: "ada@example.test" },
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
      "command:help",
    ]);
    expect(menu?.querySelector(".sidebar-identity-menu__header")?.textContent?.trim()).toBe(
      "ada@example.test",
    );
    expect(
      menu
        ?.querySelector('wa-dropdown-item[value="command:settings"] .session-menu__shortcut')
        ?.textContent?.trim(),
    ).toMatch(/^(⌘⇧,|Ctrl\+Shift\+,)$/u);
    expect(menu?.style.getPropertyValue("--sidebar-identity-menu-min-width")).toBe("212px");
    expect(menu?.querySelector(".sidebar-pair-mobile")?.hasAttribute("disabled")).toBe(true);
    expect(menu?.querySelector("openclaw-sidebar-build-chip")).not.toBeNull();
    expect(menu?.querySelector("openclaw-theme-mode-toggle")).not.toBeNull();

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
});
