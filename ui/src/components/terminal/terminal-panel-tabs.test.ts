/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { renderTerminalPanelTabs } from "./terminal-panel-tabs.ts";

describe("renderTerminalPanelTabs", () => {
  it("keeps the new-session control outside Web Awesome until a tab exists", () => {
    const container = document.createElement("div");
    const onNew = vi.fn();

    render(
      renderTerminalPanelTabs({
        tabs: [],
        activeId: null,
        booting: false,
        onSelect: vi.fn(),
        onClose: vi.fn(),
        onNew,
      }),
      container,
    );

    expect(container.querySelector("wa-tab-group")).toBeNull();
    const button = container.querySelector<HTMLButtonElement>(".tp-new");
    expect(button?.hasAttribute("slot")).toBe(false);
    button?.click();
    expect(onNew).toHaveBeenCalledOnce();
  });

  it("slots the new-session control into a nonempty tab group", () => {
    const container = document.createElement("div");

    render(
      renderTerminalPanelTabs({
        tabs: [
          {
            id: "tab-1",
            sequence: 1,
            shellName: "bash",
            agentId: "main",
            cwd: "/work",
            status: "live",
          },
        ],
        activeId: "tab-1",
        booting: false,
        onSelect: vi.fn(),
        onClose: vi.fn(),
        onNew: vi.fn(),
      }),
      container,
    );

    expect(container.querySelector("wa-tab-group")).not.toBeNull();
    expect(container.querySelector(".tp-new")?.getAttribute("slot")).toBe("nav");
  });
});
