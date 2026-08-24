/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginSessionToolMode } from "../../../../../packages/gateway-protocol/src/index.js";
import {
  handleChatComposerToolModeSelection,
  renderChatComposerToolModeMenu,
  type ChatComposerToolModeMenuProps,
} from "./chat-composer-tool-mode-menu.ts";

const common = {
  pluginId: "developer-mode",
  controlLabel: "Tool mode",
  toolProfile: "coding",
} as const;

const modes: PluginSessionToolMode[] = [
  { ...common, id: "standard", label: "Standard", default: true, codeMode: "direct" },
  { ...common, id: "code", label: "Code", codeMode: "code" },
];

const containers: HTMLElement[] = [];

afterEach(() => {
  for (const container of containers.splice(0)) {
    container.remove();
  }
});

function mount(overrides: Partial<ChatComposerToolModeMenuProps> = {}) {
  const onSelect = vi.fn();
  const props: ChatComposerToolModeMenuProps = {
    modes,
    selected: { pluginId: "developer-mode", modeId: "standard" },
    active: null,
    runtimeId: "openclaw",
    disabled: false,
    onSelect,
    ...overrides,
  };
  const container = document.createElement("div");
  containers.push(container);
  document.body.append(container);
  render(renderChatComposerToolModeMenu(props), container);
  return { container, onSelect, props };
}

function item(container: ParentNode, label: string) {
  const match = Array.from(container.querySelectorAll<HTMLElement>("wa-dropdown-item")).find(
    (candidate) =>
      Array.from(candidate.children).some(
        (child) =>
          child.tagName === "SPAN" &&
          !child.hasAttribute("slot") &&
          child.textContent?.trim() === label,
      ),
  );
  if (!match) {
    throw new Error(`Expected Tool mode item: ${label}`);
  }
  return match as HTMLElement & { disabled: boolean };
}

describe("chat composer Tool mode menu", () => {
  it("renders plugin modes and dispatches a decoded selection", () => {
    const { container, onSelect, props } = mount();

    expect(item(container, "Tool mode")).toBeTruthy();
    expect(item(container, "Standard").disabled).toBe(true);
    expect(item(container, "Code").getAttribute("slot")).toBe("submenu");

    expect(handleChatComposerToolModeSelection("tool-mode:developer-mode:code", props)).toBe(true);
    expect(onSelect).toHaveBeenCalledWith({ pluginId: "developer-mode", modeId: "code" });
  });

  it("disables incompatible modes and distinguishes active from next", () => {
    const incompatible = mount({ runtimeId: "codex" });
    expect(item(incompatible.container, "Tool mode").disabled).toBe(true);
    expect(item(incompatible.container, "Tool mode").getAttribute("title")).toContain("openclaw");

    const pending = mount({
      selected: { pluginId: "developer-mode", modeId: "code" },
      active: { pluginId: "developer-mode", modeId: "standard" },
    });
    expect(item(pending.container, "Standard").textContent).toContain("Active");
    expect(item(pending.container, "Code").textContent).toContain("Next");
  });

  it("surfaces an unavailable persisted selection", () => {
    const { container } = mount({ modes: [] });

    expect(item(container, "Tool mode unavailable").disabled).toBe(true);
  });

  it("surfaces an unavailable selection while keeping replacement modes visible", () => {
    const { container } = mount({
      modes: [modes[0]!],
      selected: { pluginId: "developer-mode", modeId: "removed" },
    });

    expect(item(container, "Tool mode unavailable").disabled).toBe(true);
    expect(item(container, "Standard")).toBeTruthy();
  });
});
