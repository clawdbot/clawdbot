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
        key: { catalogId: "codex", hostId: "gateway:local", threadId: "thread-1" },
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

  it("does not schedule trigger retargeting while the menu is closed", () => {
    const controller = new SidebarCatalogMenuController({
      beforeOpen: vi.fn(),
      requestUpdate: vi.fn(),
      terminalAvailable: () => true,
      navigate: vi.fn(),
    });
    const trigger = document.createElement("button");
    document.body.append(trigger);
    const queueMicrotaskSpy = vi.spyOn(globalThis, "queueMicrotask");

    try {
      controller.retargetTrigger(
        { catalogId: "codex", hostId: "gateway:local", threadId: "thread-1" },
        trigger,
      );
      expect(queueMicrotaskSpy).not.toHaveBeenCalled();
    } finally {
      queueMicrotaskSpy.mockRestore();
      trigger.remove();
    }
  });
});
