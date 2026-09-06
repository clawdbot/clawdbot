/* @vitest-environment jsdom */

import { html, nothing } from "lit";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { GatewayBrowserClient } from "../../../api/gateway.ts";
import "../../../components/resizable-divider.ts";
import { createControlUiPluginHost } from "../../../plugins/control-ui-host.ts";
import {
  ControlUiPluginRuntime,
  type ControlUiPluginOwner,
} from "../../../plugins/control-ui-runtime.ts";
import {
  availableSidebarSlots,
  sidebarPanelDefinitions,
  sidebarPanelTemplates,
} from "../chat-pane-embedded-panels.ts";
import { createInitializationContext } from "../chat-pane.test-support.ts";
import { createPageState } from "../chat-state-page.ts";
import {
  activatePanel,
  openSlot,
  closeSlot,
  promoteSidebarPanel,
  setSidebarOpen,
  setSidebarDock,
  setSidebarExpanded,
  type SidebarLayout,
} from "../sidebar-layout.ts";
import type { SidebarPanelDefinition } from "./chat-sidebar-region-types.ts";
import "./chat-sidebar-region.runtime.ts";

type Region = HTMLElementTagNameMap["openclaw-chat-sidebar-region"] & {
  updateComplete: Promise<unknown>;
};

const regions: Region[] = [];

async function createRegion(
  layout: SidebarLayout = openSlot({ columns: [] }, "detail"),
  definitions?: SidebarPanelDefinition[],
) {
  const shell = document.createElement("div");
  shell.className = "sidebar-region";
  const region = document.createElement("openclaw-chat-sidebar-region") as Region;
  region.layout = layout;
  region.panelTemplates = {
    detail: html`<div data-panel="detail">Detail panel</div>`,
    terminal: html`<div data-panel="terminal">Terminal panel</div>`,
    workspace: html`<div data-panel="workspace">Workspace panel</div>`,
  };
  region.availableSlots = ["detail", "terminal", "workspace", "companion", "dashboard"];
  if (definitions) {
    region.panelDefinitions = definitions;
    region.panelTemplates = sidebarPanelTemplates(definitions);
    region.availableSlots = availableSidebarSlots(definitions);
  }
  region.callbacks = {
    activatePanel: vi.fn(),
    closeSlot: vi.fn(),
    openSlot: vi.fn(),
    reorderPanel: vi.fn(),
    resizePanel: vi.fn(),
    setOpen: vi.fn(),
  };
  region.availableWidth = 1_200;
  const primary = document.createElement("div");
  primary.className = "sidebar-region__primary";
  primary.dataset.region = "main";
  primary.innerHTML = "<main data-primary>Primary</main>";
  const rightRuntime = document.createElement("div");
  rightRuntime.className = "sidebar-region__right-runtime";
  shell.append(region, primary, rightRuntime);
  document.body.append(shell);
  regions.push(region);
  await region.updateComplete;
  return region;
}

function root(region: Region): HTMLElement {
  return region.parentElement!;
}

afterEach(() => {
  for (const region of regions.splice(0)) {
    region.parentElement?.remove();
  }
});

describe("chat sidebar region", () => {
  it.each([false, true])(
    "retains unavailable plugin tabs and recovers their registration (initially active: %s)",
    async (initiallyActive) => {
      const slot = "plugin:fixture/notes";
      const layout = openSlot(openSlot({ columns: [] }, "workspace"), slot);
      const saved = structuredClone(layout);
      const context = createInitializationContext();
      const state = createPageState(
        context,
        { afterCommit: () => () => {}, invalidate: vi.fn() },
        document.createElement("div"),
      );
      state.sessionKey = "agent:main:main";
      state.sidebarLayout = layout;
      const runtime = new ControlUiPluginRuntime(() => context);
      const owner: Omit<ControlUiPluginOwner, "host"> = {
        descriptor: {
          pluginId: "fixture",
          name: "Fixture",
          revision: "one",
          entryUrl: "/__openclaw__/plugins/control-ui/fixture/one/index.js",
          styles: [],
        },
        client: new GatewayBrowserClient({ url: "ws://fixture.invalid" }),
        abort: new AbortController(),
        disposers: new Set(),
        contributions: {
          pages: new Map(),
          navigation: new Map(),
          panels: new Map(),
          actions: new Map(),
          replacements: new Map(),
          accessories: new Map(),
          widgets: new Map(),
        },
        selections: new Map(),
      };
      onTestFinished(() => {
        owner.abort.abort();
        owner.client.stop();
        runtime.dispose();
      });
      const entry: NonNullable<
        Parameters<typeof sidebarPanelDefinitions>[0]
      >["pluginPanels"][number] = {
        key: "fixture/notes",
        pluginId: "fixture",
        value: { id: "notes", label: "Fixture notes", mount: () => undefined },
        host: createControlUiPluginHost(() => context, runtime, owner),
        signal: owner.abort.signal,
      };
      const params: NonNullable<Parameters<typeof sidebarPanelDefinitions>[0]> = {
        state,
        themeMode: "dark",
        agentId: "main",
        browserPresented: false,
        browserRefreshOnPresentation: false,
        desktopPresented: false,
        desktopRefreshOnPresentation: false,
        desktopAvailable: false,
        desktopSource: null,
        desktopFocusHref: "",
        onDesktopFocusTargetChange: vi.fn(),
        dashboard: nothing,
        workspace: html`<div data-panel="workspace">Workspace panel</div>`,
        tasks: nothing,
        renderDetail: () => html``,
        digest: null,
        activeRunId: null,
        startedAt: undefined,
        lastReadAt: undefined,
        pullRequests: [],
        companion: {
          exchanges: [],
          loading: false,
          pendingQuestion: null,
          failedQuestion: null,
          hint: null,
          draft: "",
        },
        onCompanionSubmit: vi.fn(),
        onCompanionDraftChange: vi.fn(),
        onCompanionVisibilityChange: vi.fn(),
        connected: false,
        pendingQuestion: null,
        onClearCompanion: vi.fn(),
        onRefreshTasks: vi.fn(),
        tasksLoading: false,
        discussion: null,
        discussionAvailable: false,
        discussionOpenUrl: null,
        discussionSourceGeneration: 0,
        pluginPanels: initiallyActive ? [entry] : [],
        isPluginPanelPresented: () => true,
      };
      const region = await createRegion(layout, sidebarPanelDefinitions(params));
      params.pluginPanels = [];
      const refresh = async () => {
        region.panelDefinitions = sidebarPanelDefinitions(params);
        region.panelTemplates = sidebarPanelTemplates(region.panelDefinitions);
        region.availableSlots = availableSidebarSlots(region.panelDefinitions);
        await region.updateComplete;
      };
      await refresh();

      const unavailable = root(region).querySelector(
        `[data-panel-slot="${slot}"] openclaw-panel-empty-state`,
      );
      await (unavailable as HTMLElement & { updateComplete?: Promise<unknown> })?.updateComplete;
      expect(unavailable?.shadowRoot?.textContent).toContain(
        "The plugin that owns this tab is not active",
      );
      expect(region.availableSlots).not.toContain(slot);
      expect(region.layout).toEqual(saved);
      root(region)
        .querySelector<HTMLButtonElement>('button[aria-label="Close fixture/notes"]')
        ?.click();
      expect(region.callbacks?.closeSlot).toHaveBeenCalledWith(slot);

      root(region)
        .querySelector('wa-tab[panel="workspace"]')
        ?.dispatchEvent(
          new CustomEvent("wa-tab-show", { bubbles: true, detail: { name: "workspace" } }),
        );
      expect(region.callbacks?.activatePanel).toHaveBeenCalledWith("workspace");
      region.layout = activatePanel(region.layout, "workspace");
      await region.updateComplete;
      expect(
        root(region).querySelector('[data-panel-slot="workspace"]')?.hasAttribute("hidden"),
      ).toBe(false);
      expect(root(region).querySelector('[data-panel="workspace"]')?.textContent).toBe(
        "Workspace panel",
      );

      params.pluginPanels = [entry];
      await refresh();
      expect(region.availableSlots).toContain(slot);
      expect(
        root(region).querySelector(`[data-panel-slot="${slot}"] openclaw-plugin-view`),
      ).not.toBeNull();
      expect(root(region).querySelector('button[aria-label="Close Fixture notes"]')).not.toBeNull();
      expect(region.layout.columns[0]?.panels).toEqual(saved.columns[0]?.panels);
    },
  );

  it("renders all open types as one tab strip and keeps inactive panels mounted", async () => {
    const layout = openSlot(openSlot(openSlot({ columns: [] }, "detail"), "terminal"), "workspace");
    const region = await createRegion(layout);

    expect(root(region).querySelectorAll(".side-panel")).toHaveLength(1);
    expect(
      Array.from(root(region).querySelectorAll(".tabstrip-tab__label"), (node) =>
        node.textContent?.trim(),
      ),
    ).toEqual(["Review", "Terminal", "Files"]);
    expect(
      root(region).querySelector('[data-panel-slot="workspace"]')?.hasAttribute("hidden"),
    ).toBe(false);
    expect(root(region).querySelector('[data-panel-slot="detail"]')?.hasAttribute("hidden")).toBe(
      true,
    );
    expect(root(region).querySelector('[data-panel="detail"]')).not.toBeNull();
  });

  it("renders only the active panel's supplied header action", async () => {
    const onClear = vi.fn();
    const region = await createRegion(openSlot(openSlot({ columns: [] }, "detail"), "companion"));
    region.panelActions = {
      companion: html`<button class="chat-session-rail__clear" type="button" @click=${onClear}>
        Clear
      </button>`,
    };
    await region.updateComplete;

    const actions = root(region).querySelector(".side-panel__action-group--content");
    const clear = actions?.querySelector<HTMLButtonElement>("button.chat-session-rail__clear");
    expect(clear).not.toBeNull();
    clear?.click();
    expect(onClear).toHaveBeenCalledOnce();

    // Actions belong to the active panel only: the Side chat action must not
    // survive a switch to a tab that owns no header action.
    const detail = region.layout.columns[0]!.panels[0]!;
    region.layout = {
      ...region.layout,
      columns: [{ ...region.layout.columns[0]!, activePanelId: detail.id }],
    };
    await region.updateComplete;
    expect(root(region).querySelector("button.chat-session-rail__clear")).toBeNull();
  });

  it("routes tab selection and individual close through the canonical callbacks", async () => {
    const region = await createRegion(openSlot(openSlot({ columns: [] }, "detail"), "terminal"));
    const detail = region.layout.columns[0]!.panels[0]!;
    root(region)
      .querySelector(`wa-tab[panel="${detail.id}"]`)
      ?.dispatchEvent(
        new CustomEvent("wa-tab-show", { bubbles: true, detail: { name: detail.id } }),
      );
    root(region).querySelector<HTMLButtonElement>('button[aria-label="Close Review"]')?.click();

    expect(region.callbacks?.activatePanel).toHaveBeenCalledWith(detail.id);
    expect(region.callbacks?.closeSlot).toHaveBeenCalledWith("detail");
  });

  it("renders one separator per gap so the active tab never reflows the row", async () => {
    const region = await createRegion(
      openSlot(openSlot(openSlot({ columns: [] }, "detail"), "terminal"), "workspace"),
    );

    const separators = root(region).querySelectorAll(".tabstrip-separator");
    expect(separators).toHaveLength(2);
    for (const separator of separators) {
      expect(separator.previousElementSibling?.classList.contains("tabstrip-tab__close")).toBe(
        true,
      );
      expect(separator.nextElementSibling?.classList.contains("tabstrip-tab")).toBe(true);
    }
  });

  it("delivers typed requests to the mounted panel owner", async () => {
    const handleToggleRequest = vi.fn();
    const region = await createRegion(openSlot({ columns: [] }, "terminal"));
    region.panelTemplates = {
      terminal: html`<div .handleToggleRequest=${handleToggleRequest}>Terminal panel</div>`,
    };
    await region.updateComplete;
    const event = new CustomEvent("openclaw:terminal-toggle", {
      detail: { catalog: { catalogId: "codex", hostId: "gateway:local", threadId: "thread-1" } },
    });

    expect(region.deliverPanelEvent("terminal", event)).toBe(true);
    expect(handleToggleRequest).toHaveBeenCalledWith(event);
  });

  it("opens a type from the plus menu and shows shortcuts for available panels", async () => {
    const region = await createRegion();
    const dropdown = root(region).querySelector(".side-panel-type-menu");
    dropdown?.dispatchEvent(
      new CustomEvent("wa-select", {
        bubbles: true,
        detail: { item: { value: "terminal" } },
      }),
    );

    expect(region.callbacks?.openSlot).toHaveBeenCalledWith("terminal");
    expect(
      Array.from(root(region).querySelectorAll(".side-panel-type-option__shortcut"), (node) =>
        node.textContent?.trim(),
      ),
    ).toEqual(["Ctrl+`", "Ctrl+Shift+B", "Ctrl+Shift+S", "Ctrl+Alt+Shift+G"]);
    const reviewItem = Array.from(
      root(region).querySelectorAll<HTMLElement>("wa-dropdown-item"),
    ).find((item) => Reflect.get(item, "value") === "detail");
    expect(reviewItem).toBeUndefined();
    expect(root(region).querySelector("wa-dropdown-item[disabled]")).toBeNull();
  });

  it("keeps Browser available in the plus menu to start another browser tab", async () => {
    const handleToggleRequest = vi.fn();
    const region = await createRegion(openSlot({ columns: [] }, "browser"));
    region.panelTemplates = {
      browser: html`<div .handleToggleRequest=${handleToggleRequest}>Browser panel</div>`,
    };
    region.availableSlots = [...region.availableSlots, "browser"];
    await region.updateComplete;
    const browserItem = Array.from(
      root(region).querySelectorAll<HTMLElement>("wa-dropdown-item"),
    ).find((item) => Reflect.get(item, "value") === "browser");

    expect(browserItem).toBeDefined();
    root(region)
      .querySelector(".side-panel-type-menu")
      ?.dispatchEvent(
        new CustomEvent("wa-select", {
          bubbles: true,
          detail: { item: { value: "browser" } },
        }),
      );

    expect(region.callbacks?.openSlot).toHaveBeenCalledWith("browser");
    expect(handleToggleRequest).toHaveBeenCalledWith(
      expect.objectContaining({ detail: { open: true, newTab: true } }),
    );
  });

  it("opens into a type selector instead of restoring a previous tab", async () => {
    const region = await createRegion(setSidebarOpen({ columns: [], expanded: false }, true));
    const selector = root(region).querySelector(".side-panel-empty--selector");

    expect(selector?.querySelector(".side-panel-empty__title")).toBeNull();
    expect(selector?.querySelector(".side-panel-empty__description")).toBeNull();
    expect(selector?.querySelector(":scope > .side-panel-empty__icon")).toBeNull();
    expect(
      Array.from(selector?.querySelectorAll(".side-panel-empty__type") ?? [], (item) =>
        item.textContent?.replace(/\s+/gu, " ").trim(),
      ),
    ).toEqual([
      "Review Ctrl+Alt+Shift+E",
      "Terminal Ctrl+`",
      "Files Ctrl+Shift+B",
      "Side chat Ctrl+Shift+S",
      "Dashboard Ctrl+Alt+Shift+G",
    ]);
    root(region).querySelector<HTMLButtonElement>(".side-panel-empty__type")?.click();
    expect(region.callbacks?.openSlot).toHaveBeenCalledWith("detail");

    const dashboard = Array.from(
      root(region).querySelectorAll<HTMLButtonElement>(".side-panel-empty__type"),
    ).find(
      (button) =>
        button.querySelector(".side-panel-type-option__label")?.textContent === "Dashboard",
    );
    dashboard?.click();
    expect(region.callbacks?.openSlot).toHaveBeenCalledWith("dashboard");
  });

  it("gives every surface the shared icon, title, and description empty state", async () => {
    const region = await createRegion(openSlot({ columns: [] }, "companion"));
    region.panelTemplates = {};

    for (const [slot, label] of [
      ["detail", "Review"],
      ["browser", "Browser"],
      ["terminal", "Terminal"],
      ["workspace", "Files"],
      ["companion", "Side chat"],
      ["tasks", "Tasks"],
      ["discussion", "Discussion"],
    ] as const) {
      region.layout = openSlot({ columns: [] }, slot);
      await region.updateComplete;
      const empty = root(region).querySelector(".side-panel-empty--type");
      const state = empty?.querySelector("openclaw-panel-empty-state");
      await (state as HTMLElement & { updateComplete?: Promise<unknown> })?.updateComplete;
      expect(state?.querySelector("svg")).not.toBeNull();
      expect(state?.shadowRoot?.querySelector(".empty-state__title")?.textContent).toBe(label);
      expect(
        state?.shadowRoot?.querySelector(".empty-state__description")?.textContent?.trim(),
      ).not.toBe("");
    }
  });

  it("offers every chat-side content owner through the shared type menu", async () => {
    const region = await createRegion();
    region.availableSlots = [
      "detail",
      "terminal",
      "browser",
      "workspace",
      "companion",
      "tasks",
      "desktop",
      "discussion",
      "dashboard",
    ];
    await region.updateComplete;

    expect(
      Array.from(root(region).querySelectorAll(".side-panel-type-menu__item"), (item) =>
        item.textContent?.replace(/\s+/gu, " ").trim(),
      ),
    ).toEqual([
      "Terminal Ctrl+`",
      "Browser Ctrl+Alt+Shift+U",
      "Files Ctrl+Shift+B",
      "Side chat Ctrl+Shift+S",
      "Tasks Ctrl+Alt+Shift+K",
      "Desktop Ctrl+Alt+Shift+D",
      "Discussion Ctrl+Alt+Shift+J",
      "Dashboard Ctrl+Alt+Shift+G",
    ]);

    const browserMenuItem = Array.from(
      root(region).querySelectorAll<HTMLElement>(".side-panel-type-menu__item"),
    ).find((item) => Reflect.get(item, "value") === "browser");
    expect(browserMenuItem?.querySelector('path[d="M2 12h20"]')).not.toBeNull();

    region.layout = openSlot({ columns: [] }, "browser");
    await region.updateComplete;
    expect(root(region).querySelector('.tabstrip-tab__icon path[d="M2 12h20"]')).not.toBeNull();

    region.layout = { columns: [], open: true };
    await region.updateComplete;
    const browserEmptyItem = Array.from(
      root(region).querySelectorAll<HTMLElement>(".side-panel-empty__type"),
    ).find(
      (item) => item.querySelector(".side-panel-type-option__label")?.textContent === "Browser",
    );
    expect(browserEmptyItem?.querySelector('path[d="M2 12h20"]')).not.toBeNull();
  });

  it("keeps side tab dismissal separate from task toolbar actions", async () => {
    const region = await createRegion();
    root(region)
      .querySelector<HTMLButtonElement>('[data-region-header="side"] .side-panel__minimize')
      ?.click();
    expect(region.callbacks?.setOpen).toHaveBeenCalledWith(false);
    region.layout = setSidebarExpanded(promoteSidebarPanel(region.layout, "detail"), true);
    await region.updateComplete;
    expect(root(region).querySelector('[data-region-header="main"]')).toBeNull();
    expect(
      Array.from(root(region).querySelectorAll(".tabstrip-tab__label"), (node) =>
        node.textContent?.trim(),
      ),
    ).toEqual(["Chat"]);
  });

  it("opens an empty selector without adding another title row", async () => {
    const region = await createRegion(setSidebarOpen({ columns: [] }, true));
    expect(root(region).querySelector("resizable-divider")).not.toBeNull();
    expect(root(region).querySelector(".side-panel-empty__types")).not.toBeNull();
    expect(root(region).querySelector("[data-region-header]")).toBeNull();
  });

  it("uses one inherited divider and reports bounded panel width", async () => {
    const region = await createRegion();
    const primary = root(region).querySelector<HTMLElement>(".sidebar-region__primary")!;
    const panel = root(region).querySelector<HTMLElement>('[data-region="side"]:not([hidden])')!;
    const divider = root(region).querySelector<HTMLElement>("resizable-divider")!;
    primary.getBoundingClientRect = () => ({ width: 800 }) as DOMRect;
    panel.getBoundingClientRect = () => ({ width: 360 }) as DOMRect;
    divider.dispatchEvent(
      new CustomEvent("resize", { bubbles: true, detail: { splitRatio: 0.5 } }),
    );
    expect(region.callbacks?.resizePanel).toHaveBeenCalledWith(region.layout.columns[0]!.id, 580);
  });

  it("docks and resizes the same panel across left, right, and bottom layouts", async () => {
    const region = await createRegion(
      setSidebarDock(openSlot({ columns: [] }, "detail"), "bottom"),
    );
    const primary = root(region).querySelector<HTMLElement>(".sidebar-region__primary")!;
    const panel = root(region).querySelector<HTMLElement>('[data-region="side"]:not([hidden])')!;
    const divider = root(region).querySelector<HTMLElement & { orientation: string }>(
      "resizable-divider",
    )!;
    primary.getBoundingClientRect = () => ({ height: 440 }) as DOMRect;
    panel.getBoundingClientRect = () => ({ height: 360 }) as DOMRect;
    root(region).getBoundingClientRect = () => ({ height: 800 }) as DOMRect;

    expect(divider.orientation).toBe("horizontal");
    divider.dispatchEvent(
      new CustomEvent("resize", { bubbles: true, detail: { splitRatio: 0.5 } }),
    );
    expect(region.callbacks?.resizePanel).toHaveBeenCalledWith(region.layout.columns[0]!.id, 400);
    region.layout = setSidebarDock(region.layout, "left");
    await region.updateComplete;
    primary.getBoundingClientRect = () => ({ width: 800 }) as DOMRect;
    panel.getBoundingClientRect = () => ({ width: 400 }) as DOMRect;
    const leftDivider = root(region).querySelector<HTMLElement & { orientation: string }>(
      "resizable-divider",
    )!;
    expect(leftDivider.orientation).toBe("vertical");
    leftDivider.dispatchEvent(
      new CustomEvent("resize", { bubbles: true, detail: { splitRatio: 0.25 } }),
    );
    expect(region.callbacks?.resizePanel).toHaveBeenLastCalledWith(
      region.layout.columns[0]!.id,
      300,
    );
  });

  it("retains hidden side content and visible main content when the side panel is minimized", async () => {
    const layout = promoteSidebarPanel(
      openSlot(openSlot({ columns: [] }, "detail"), "terminal"),
      "detail",
    );
    const region = await createRegion(setSidebarOpen(layout, false));
    expect(root(region).querySelector('[data-panel-slot="terminal"]')?.hasAttribute("hidden")).toBe(
      true,
    );
    expect(root(region).querySelector('[data-panel="terminal"]')).not.toBeNull();
    expect(root(region).querySelector('[data-panel-slot="detail"]')?.hasAttribute("hidden")).toBe(
      false,
    );
    expect(root(region).querySelector("resizable-divider")).toBeNull();
    expect(root(region).querySelector('[data-region-header="main"]')).toBeNull();
    expect(root(region).querySelector("[data-primary]")).not.toBeNull();
  });

  it("retains app input and terminal content while minimizing until their tabs close", async () => {
    const region = await createRegion(
      setSidebarOpen(openSlot(openSlot({ columns: [] }, "terminal"), "dashboard"), false),
    );
    region.panelTemplates = {
      ...region.panelTemplates,
      dashboard: html`<input aria-label="Unsaved app input" />`,
    };
    await region.updateComplete;
    expect(root(region).querySelector('[data-panel-slot="dashboard"]')).toBeNull();
    region.layout = setSidebarOpen(region.layout, true);
    await region.updateComplete;
    const input = root(region).querySelector<HTMLInputElement>("input")!;
    input.value = "Unsaved note";
    const terminal = root(region).querySelector('[data-panel="terminal"]')!;

    region.layout = setSidebarOpen(region.layout, false);
    await region.updateComplete;
    const panel = root(region).querySelector<HTMLElement>('[data-panel-slot="dashboard"]')!;
    expect(panel.hidden).toBe(true);
    expect(root(region).querySelector("resizable-divider")).toBeNull();
    expect(input.isConnected).toBe(true);
    expect(terminal.isConnected).toBe(true);
    expect(root(region).querySelector<HTMLElement>('[data-panel-slot="terminal"]')?.hidden).toBe(
      true,
    );

    region.layout = setSidebarOpen(region.layout, true);
    await region.updateComplete;
    expect(root(region).querySelector("input")).toBe(input);
    expect(input.value).toBe("Unsaved note");
    expect(panel.hidden).toBe(false);
    expect(root(region).querySelector('[data-panel="terminal"]')).toBe(terminal);

    region.layout = closeSlot(region.layout, "dashboard");
    await region.updateComplete;
    expect(input.isConnected).toBe(false);
    expect(root(region).querySelector('[data-panel="terminal"]')).toBe(terminal);
    expect(root(region).querySelector<HTMLElement>('[data-panel-slot="terminal"]')?.hidden).toBe(
      false,
    );
  });
});
