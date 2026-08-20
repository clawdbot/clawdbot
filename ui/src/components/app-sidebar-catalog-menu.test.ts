/* @vitest-environment jsdom */

import { describe, expect, it, vi } from "vitest";
import { SidebarCatalogMenuController } from "./app-sidebar-catalog-menu.ts";
import { SESSION_MENU_OPEN_EVENT } from "./session-progress-hovercard-target.ts";

describe("SidebarCatalogMenuController", () => {
  it("dismisses the matching hovercard before opening the catalog menu", () => {
    const trigger = document.createElement("button");
    const order: string[] = [];
    trigger.addEventListener(SESSION_MENU_OPEN_EVENT, () => order.push("dismiss"));
    const controller = new SidebarCatalogMenuController({
      beforeOpen: () => order.push("open"),
      requestUpdate: vi.fn(),
      terminalAvailable: () => true,
      navigate: vi.fn(),
    });

    controller.open(
      {
        key: "catalog:codex:gateway%3Alocal:thread-1",
        agentId: "main",
        routeId: "chat",
        navigation: {},
        canOpenTerminal: true,
        meta: "now",
      },
      10,
      20,
      trigger,
    );

    expect(order).toEqual(["dismiss", "open"]);
  });
});
