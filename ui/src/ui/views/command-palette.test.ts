import { nothing, render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../../i18n/index.ts";
import { refreshSlashCommands, resetSlashCommandsForTest } from "../chat/slash-commands.ts";
import {
  getFilteredPaletteItems,
  getPaletteItems,
  renderCommandPalette,
  type CommandPaletteProps,
} from "./command-palette.ts";

let container: HTMLDivElement;

const showModalDescriptor = Object.getOwnPropertyDescriptor(
  HTMLDialogElement.prototype,
  "showModal",
);

function nextFrame() {
  return new Promise<void>((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

function installDialogPolyfill() {
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.setAttribute("open", "");
    },
  });
}

function restoreShowModalDescriptor() {
  if (showModalDescriptor) {
    Object.defineProperty(HTMLDialogElement.prototype, "showModal", showModalDescriptor);
    return;
  }
  delete (HTMLDialogElement.prototype as Partial<HTMLDialogElement>).showModal;
}

function expectPaletteInput(): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>("#cmd-palette-input");
  if (!(input instanceof HTMLInputElement)) {
    throw new Error("Expected command palette input");
  }
  return input;
}

function expectPaletteDialog(): HTMLDialogElement {
  const dialog = container.querySelector<HTMLDialogElement>("dialog.cmd-palette-overlay");
  if (!(dialog instanceof HTMLDialogElement)) {
    throw new Error("Expected command palette dialog");
  }
  return dialog;
}

function createProps(overrides: Partial<CommandPaletteProps> = {}): CommandPaletteProps {
  return {
    open: true,
    query: "",
    activeIndex: 0,
    onToggle: () => undefined,
    onQueryChange: () => undefined,
    onActiveIndexChange: () => undefined,
    onNavigate: () => undefined,
    onSlashCommand: () => undefined,
    ...overrides,
  };
}

async function renderPalette(overrides: Partial<CommandPaletteProps> = {}) {
  const props = createProps(overrides);
  render(renderCommandPalette(props), container);
  await nextFrame();
  return props;
}

beforeEach(() => {
  installDialogPolyfill();
  container = document.createElement("div");
  document.body.append(container);
});

afterEach(async () => {
  render(nothing, container);
  container.remove();
  restoreShowModalDescriptor();
  vi.restoreAllMocks();
  resetSlashCommandsForTest();
  await i18n.setLocale("en");
});

describe("command palette", () => {
  it("builds slash items from the live runtime command list", async () => {
    const request = async (method: string) => {
      expect(method).toBe("commands.list");
      return {
        commands: [
          {
            name: "pair",
            textAliases: ["/pair"],
            description: "Generate setup codes and approve device pairing requests.",
            source: "plugin",
            scope: "both",
            acceptsArgs: true,
          },
          {
            name: "prose",
            textAliases: ["/prose"],
            description: "Draft polished prose.",
            source: "skill",
            scope: "both",
            acceptsArgs: true,
          },
        ],
      };
    };

    await refreshSlashCommands({
      client: { request } as never,
      agentId: "main",
    });

    const items = getPaletteItems();
    expect(items).toContainEqual(
      expect.objectContaining({
        id: "slash:pair",
        label: "/pair",
      }),
    );
    expect(items).toContainEqual(
      expect.objectContaining({
        id: "slash:prose",
        label: "/prose",
      }),
    );
  });

  it("matches localized base item labels and descriptions", async () => {
    await i18n.setLocale("zh-CN");

    expect(getPaletteItems()).toContainEqual(
      expect.objectContaining({
        id: "nav-config",
        label: "设置",
      }),
    );
    expect(getFilteredPaletteItems("切换调试")).toContainEqual(
      expect.objectContaining({
        id: "skill-debug",
      }),
    );
  });

  it("renders a labelled modal combobox with listbox options", async () => {
    await renderPalette({ query: "overview", activeIndex: 0 });

    const dialog = container.querySelector<HTMLDialogElement>("dialog.cmd-palette-overlay");
    expect(dialog?.open).toBe(true);
    expect(dialog?.hasAttribute("role")).toBe(false);
    expect(dialog?.hasAttribute("aria-modal")).toBe(false);
    expect(dialog?.getAttribute("aria-labelledby")).toBe("cmd-palette-label");

    const label = container.querySelector<HTMLLabelElement>("#cmd-palette-label");
    const input = container.querySelector<HTMLInputElement>("#cmd-palette-input");
    const listbox = container.querySelector<HTMLElement>("#cmd-palette-listbox");
    expect(label?.textContent).toBe("Type a command…");
    expect(label?.getAttribute("for")).toBe("cmd-palette-input");
    expect(input?.getAttribute("role")).toBe("combobox");
    expect(input?.getAttribute("aria-autocomplete")).toBe("list");
    expect(input?.getAttribute("aria-expanded")).toBe("true");
    expect(input?.getAttribute("aria-controls")).toBe("cmd-palette-listbox");
    expect(input?.getAttribute("aria-activedescendant")).toBe("cmd-palette-option-nav-overview");
    expect(document.activeElement).toBe(input);

    expect(listbox?.getAttribute("role")).toBe("listbox");
    const option = listbox?.querySelector<HTMLElement>("#cmd-palette-option-nav-overview");
    expect(option?.getAttribute("role")).toBe("option");
    expect(option?.getAttribute("aria-selected")).toBe("true");
  });

  it("traps Tab on the combobox and restores focus on Escape", async () => {
    const returnTarget = document.createElement("button");
    returnTarget.textContent = "Open palette";
    document.body.append(returnTarget);
    returnTarget.focus();
    const onToggle = vi.fn();

    await renderPalette({ onToggle });
    const input = expectPaletteInput();
    expect(document.activeElement).toBe(input);

    const tab = new KeyboardEvent("keydown", {
      key: "Tab",
      bubbles: true,
      cancelable: true,
    });
    input.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(input);

    const escape = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    input.dispatchEvent(escape);
    expect(escape.defaultPrevented).toBe(true);
    expect(onToggle).toHaveBeenCalledTimes(1);

    await nextFrame();
    expect(document.activeElement).toBe(returnTarget);
    returnTarget.remove();
  });

  it("does not toggle twice when Escape is followed by dialog cancel", async () => {
    const onToggle = vi.fn();
    await renderPalette({ onToggle });
    const dialog = expectPaletteDialog();
    const input = expectPaletteInput();
    expect(dialog.open).toBe(true);

    input.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      }),
    );
    dialog.dispatchEvent(new Event("cancel", { cancelable: true }));

    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});
