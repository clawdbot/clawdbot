import { afterEach, describe, expect, it } from "vitest";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import "../test-helpers/load-styles.ts";

afterEach(() => document.body.replaceChildren());

describe.runIf("__vitest_browser__" in globalThis)("identity menu keyboard navigation", () => {
  it("traverses the actual item order and both footer controls in each direction", async () => {
    await import("./app-sidebar.ts");
    const { createGatewayHarness, createSessions, mountSidebar } =
      await import("../test-helpers/app-sidebar.ts");
    const { page, userEvent } = await import("vitest/browser");
    const { sidebar } = await mountSidebar(
      createGatewayHarness({ instanceId: "self-instance" } as GatewayBrowserClient).gateway,
      createSessions("main", ["agent:main:main"]),
    );
    sidebar.connected = true;
    sidebar.canPairDevice = false;
    await sidebar.updateComplete;

    const identity = sidebar.querySelector<HTMLButtonElement>(".sidebar-identity-card");
    expect(identity).not.toBeNull();
    // A pointer left by another test can open Help as the keyboard menu appears.
    await page.elementLocator(document.body).hover({ position: { x: 0, y: 0 } });
    identity?.focus();
    await userEvent.keyboard("{Enter}");

    const menu = sidebar.querySelector<HTMLElement>(".sidebar-identity-menu");
    const items = Array.from(menu?.children ?? []).filter(
      (item): item is HTMLElement & { active: boolean } =>
        item instanceof HTMLElement &&
        item.localName === "wa-dropdown-item" &&
        !item.hasAttribute("disabled"),
    );
    const theme = menu?.querySelector<HTMLButtonElement>(".theme-mode-toggle");
    const build = document.createElement("a");
    build.href = "#build";
    build.textContent = "Build details";
    menu?.querySelector(".sidebar-mode-switch")?.insertAdjacentElement("beforebegin", build);
    await expect.poll(() => document.activeElement).toBe(items[0]);

    for (const expected of items.slice(1)) {
      await userEvent.keyboard("{ArrowDown}");
      expect(document.activeElement).toBe(expected);
    }
    expect(items.at(-1)?.active).toBe(true);
    await userEvent.keyboard("{ArrowRight}");
    await expect.poll(() => document.activeElement?.getAttribute("slot")).toBe("submenu");
    await userEvent.keyboard("{ArrowDown}");
    expect(document.activeElement?.getAttribute("slot")).toBe("submenu");
    await userEvent.keyboard("{ArrowLeft}");
    await expect.poll(() => document.activeElement).toBe(items.at(-1));
    await userEvent.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(build);
    await userEvent.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(theme);
    await userEvent.keyboard("{ArrowUp}");
    expect(document.activeElement).toBe(build);
    await userEvent.keyboard("{ArrowUp}");
    expect(document.activeElement).toBe(items.at(-1));
    expect(items.at(-1)?.active).toBe(true);

    build.remove();
    await userEvent.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(theme);
    const onThemeChange = new Promise<CustomEvent<{ mode: string }>>((resolve) => {
      menu?.addEventListener(
        "theme-change",
        (event) => resolve(event as CustomEvent<{ mode: string }>),
        {
          once: true,
        },
      );
    });
    await userEvent.keyboard("{Enter}");
    expect((await onThemeChange).detail.mode).toBe("light");
    await userEvent.keyboard("{Tab}");
    await expect.poll(() => (menu as HTMLElement & { open: boolean }).open).toBe(false);
  });
});
