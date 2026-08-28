/* @vitest-environment jsdom */

import { html, render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { renderConfigForm } from "../../components/config-form.ts";
import {
  memorySchemaKeysForTab,
  memoryTabForRoute,
  memoryVisibleSchemaKeys,
  narrowMemorySchema,
} from "./memory-schema.ts";
import { renderMemory } from "./memory.ts";

/** The view is the only public surface, so its props type comes from its signature. */
type MemoryViewProps = Parameters<typeof renderMemory>[0];

function createProps(overrides: Partial<MemoryViewProps> = {}): MemoryViewProps {
  return {
    activeTab: "settings",
    onTabChange: vi.fn(),
    engineOptions: [
      { id: "memory-core", label: "OpenClaw Memory", available: true },
      { id: "memory-lancedb", label: "Memory LanceDB", available: true },
    ],
    engineSelection: { kind: "auto", engineId: "memory-core" },
    engineState: "enabled",
    engineBusy: false,
    engineOutcome: null,
    onEngineChange: vi.fn(),
    onEngineReset: vi.fn(),
    addons: [
      {
        id: "active-memory",
        label: "Active memory",
        description: "Recent context",
        state: "enabled",
        busy: false,
        error: null,
        notice: null,
      },
      {
        id: "memory-wiki",
        label: "Memory wiki",
        description: "Wiki pages",
        state: "disabled",
        busy: false,
        error: null,
        notice: null,
      },
    ],
    canToggleAddons: true,
    onAddonChange: vi.fn(),
    pluginsHref: "/settings/plugins",
    memoryImportHref: "/memory-import",
    canImportMemory: true,
    overview: html`<div class="test-overview"></div>`,
    memories: html`<div class="test-memories"></div>`,
    dreams: html`<div class="test-dreams"></div>`,
    editor: html`<div class="test-editor"></div>`,
    dreamingSettings: html`<div class="test-dreaming-settings"></div>`,
    agentId: "main",
    agents: [
      { value: "main", label: "Main" },
      { value: "research", label: "Research" },
    ],
    onAgentChange: vi.fn(),
    ...overrides,
  };
}

function renderInto(props: MemoryViewProps): HTMLElement {
  const container = document.createElement("div");
  render(renderMemory(props), container);
  return container;
}

describe("renderMemory", () => {
  it("renders the agent scope only for multiple configured agents", () => {
    const emptyRoster = renderInto(createProps({ activeTab: "overview", agents: [] }));
    expect(emptyRoster.querySelector(".agent-scope-control")).toBeNull();

    const singleAgent = renderInto(
      createProps({
        activeTab: "overview",
        agents: [{ value: "main", label: "Main" }],
      }),
    );
    expect(singleAgent.querySelector(".agent-scope-control")).toBeNull();

    const multipleAgents = renderInto(createProps({ activeTab: "overview" }));
    expect(multipleAgents.querySelector(".agent-scope-control")).not.toBeNull();
  });

  it.each(["overview", "memories", "dreams"] as const)(
    "renders the shared header and agent scope on %s",
    (activeTab) => {
      const onAgentChange = vi.fn();
      const container = renderInto(createProps({ activeTab, onAgentChange }));
      const header = container.querySelector(".hub-page-header");

      expect(header?.querySelector(".page-title")?.textContent).toBe("Memory");
      expect(header?.querySelector(".page-subtitle")?.textContent).toContain(
        "Choose how OpenClaw stores, searches, and maintains agent memory.",
      );
      expect(header?.querySelector(".memory-hub-tabs")).not.toBeNull();
      expect(container.textContent).not.toContain("Agent view");

      const select = header?.querySelector("openclaw-agent-select") as HTMLElement & {
        accessibleLabel?: string;
        onSelect?: (value: string) => void;
      };
      expect(select.accessibleLabel).toBe("Agent");
      select.onSelect?.("research");
      expect(onAgentChange).toHaveBeenCalledWith("research");
    },
  );

  it("keeps the header action slot empty on Settings", () => {
    const container = renderInto(createProps({ activeTab: "settings" }));

    expect(container.querySelector(".hub-page-header__actions")?.childElementCount).toBe(0);
    expect(container.querySelector("openclaw-agent-select")).toBeNull();
  });

  it("replaces the memory-import link with an admin-required note", () => {
    const container = renderInto(createProps({ canImportMemory: false }));

    expect(container.querySelector('a[href="/memory-import"]')).toBeNull();
    expect(container.textContent).toContain("Memory import requires operator.admin access.");
  });

  it("shows the exclusive engine choice as one radio group over installed engines", () => {
    const container = renderInto(createProps());

    const group = container.querySelector("wa-radio-group.settings-segmented");
    expect(group).not.toBeNull();
    const values = [...container.querySelectorAll("wa-radio")].map((radio) =>
      radio.getAttribute("value"),
    );
    expect(values).toContain("memory-core");
    expect(values).toContain("memory-lancedb");
    // The trailing empty value switches the memory slot off entirely.
    expect(values).toContain("");
  });

  it.each([
    { selection: { kind: "off" } as const, value: "Off" },
    {
      selection: { kind: "pinned", engineId: "memory-core" } as const,
      value: "memory-core",
    },
  ])("keeps reset available without a catalog for $selection.kind", ({ selection, value }) => {
    const onEngineReset = vi.fn();
    const container = renderInto(
      createProps({
        engineOptions: [],
        engineSelection: selection,
        engineState: "unknown",
        onEngineReset,
      }),
    );

    expect(container.textContent).toContain(`Default: OpenClaw Memory`);
    expect(container.textContent).toContain(value);
    container.querySelector<HTMLButtonElement>('button[aria-label="Reset to default"]')?.click();
    expect(onEngineReset).toHaveBeenCalledOnce();
  });

  it("disables catalog-free reset when the effective mutation gate is closed", () => {
    const onEngineReset = vi.fn();
    const container = renderInto(
      createProps({
        engineOptions: [],
        engineSelection: { kind: "off" },
        engineState: "unknown",
        engineBusy: true,
        onEngineReset,
      }),
    );
    const reset = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Reset to default"]',
    );

    expect(reset?.disabled).toBe(true);
    reset?.click();
    expect(onEngineReset).not.toHaveBeenCalled();
  });

  it("reports whether the engine came from config or from the slot default", () => {
    const auto = renderInto(createProps());
    expect(auto.textContent).toContain("falls back to its default owner");
    expect(auto.textContent).toContain("Using default: OpenClaw Memory");
    expect(auto.querySelector('button[aria-label="Reset to default"]')).toBeNull();

    const pinned = renderInto(
      createProps({ engineSelection: { kind: "pinned", engineId: "memory-core" } }),
    );
    expect(pinned.textContent).toContain("pinned in config");
    expect(pinned.textContent).toContain("Default: OpenClaw Memory");
    expect(pinned.querySelector('button[aria-label="Reset to default"]')).not.toBeNull();
  });

  it("keeps a configured missing engine selected and labels it unavailable", () => {
    const container = renderInto(
      createProps({
        engineOptions: [{ id: "retired-memory", label: "retired-memory", available: false }],
        engineSelection: { kind: "pinned", engineId: "retired-memory" },
        engineState: "unknown",
      }),
    );

    expect(
      container
        .querySelector('wa-radio[value="retired-memory"]')
        ?.textContent?.replace(/\s+/g, " ")
        .trim(),
    ).toBe("retired-memory (Unavailable)");
    expect(
      container
        .querySelector('wa-radio[value="retired-memory"]')
        ?.classList.contains("settings-segmented__btn--active"),
    ).toBe(true);
  });

  it("surfaces a failed engine write next to the control", () => {
    expect(renderInto(createProps()).textContent).not.toContain("Could not change");

    const failed = renderInto(
      createProps({ engineOutcome: { kind: "error", message: "gateway rejected the change" } }),
    );
    expect(failed.textContent).toContain("Could not change the memory engine");
    expect(failed.textContent).toContain("gateway rejected the change");
  });

  it("selects the Off option and says so for an explicit plugins.slots.memory none", () => {
    const container = renderInto(createProps({ engineSelection: { kind: "off" } }));

    const active = container.querySelector("wa-radio.settings-segmented__btn--active");
    expect(active?.getAttribute("value")).toBe("");
    expect(container.textContent).toContain("switched off");
    expect(container.textContent).not.toContain("pinned in config");
  });

  it("renders enabled and disabled add-ons as accessible toggles", () => {
    const container = renderInto(createProps());

    const switches = [
      ...container.querySelectorAll<HTMLElement & { checked: boolean }>("wa-switch"),
    ];
    expect(switches).toHaveLength(2);
    expect(switches[0]?.checked).toBe(true);
    expect(switches[1]?.checked).toBe(false);
    expect(switches[0]?.textContent).toContain("Enable or disable Active memory");
    expect(switches[1]?.textContent).toContain("Enable or disable Memory wiki");
    const link = container.querySelector<HTMLAnchorElement>("a.memory-page__link");
    expect(link?.getAttribute("href")).toBe("/settings/plugins");
  });

  it("uses read-only add-on statuses when mutations are not authorized", () => {
    const container = renderInto(createProps({ canToggleAddons: false }));

    expect(container.querySelector("wa-switch")).toBeNull();
    expect(container.textContent).toContain("Enabled");
    expect(container.textContent).toContain("Disabled");
    expect(container.textContent).toContain("Open Plugins");
  });

  it("keeps mutation busy and errors scoped to one add-on row", () => {
    const container = renderInto(
      createProps({
        addons: [
          {
            id: "active-memory",
            label: "Active memory",
            description: "Recent context",
            state: "enabled",
            busy: true,
            error: "gateway rejected the change",
            notice: null,
          },
          {
            id: "memory-wiki",
            label: "Memory wiki",
            description: "Wiki pages",
            state: "disabled",
            busy: false,
            error: null,
            notice: null,
          },
        ],
      }),
    );
    const switches = [...container.querySelectorAll<HTMLElement>("wa-switch")];
    expect(switches[0]?.hasAttribute("disabled")).toBe(true);
    expect(switches[1]?.hasAttribute("disabled")).toBe(false);
    expect(container.textContent).toContain("Could not update Active memory");
    expect(container.textContent).toContain("gateway rejected the change");
    expect(container.textContent).not.toContain("Could not update Memory wiki");
  });

  it("never states an add-on is off while the catalog is unread", () => {
    for (const state of ["loading", "unknown"] as const) {
      const container = renderInto(
        createProps({
          addons: [
            {
              id: "active-memory",
              label: "Active memory",
              description: "x",
              state,
              busy: false,
              error: null,
              notice: null,
            },
          ],
        }),
      );
      expect(container.textContent).not.toContain("Disabled");
      expect(container.textContent).not.toContain("Enabled");
      expect(container.querySelector("wa-switch")).toBeNull();
    }
  });

  it("keeps config only on Settings and the agent experience on Dreams", () => {
    expect(
      renderInto(createProps({ activeTab: "overview" })).querySelector(".test-overview"),
    ).not.toBeNull();
    expect(
      renderInto(createProps({ activeTab: "memories" })).querySelector(".test-memories"),
    ).not.toBeNull();

    const settings = renderInto(createProps({ activeTab: "settings" }));
    expect(settings.querySelector(".test-editor")).not.toBeNull();
    expect(settings.querySelector(".test-dreaming-settings")).not.toBeNull();

    const dreams = renderInto(createProps({ activeTab: "dreams" }));
    expect(dreams.querySelector(".test-dreams")).not.toBeNull();
    expect(dreams.querySelector(".test-editor")).toBeNull();
  });

  it("shows the shared advanced disclosure only on Settings and reveals advanced fields", () => {
    const onAdvancedChange = vi.fn();
    const editor = (showAdvanced: boolean) =>
      html`${renderConfigForm({
        schema: {
          type: "object",
          properties: {
            memory: {
              type: "object",
              properties: {
                enabled: { type: "boolean", title: "Common memory field" },
                extraPaths: { type: "string", title: "Advanced memory field" },
              },
            },
          },
        },
        uiHints: {
          "memory.enabled": { advanced: false },
          "memory.extraPaths": { advanced: true },
        },
        value: { memory: { enabled: true, extraPaths: "/notes" } },
        activeSection: "memory",
        embedded: true,
        showAdvanced,
        onShowAdvanced: () => onAdvancedChange(true),
        onHideAdvanced: () => onAdvancedChange(false),
        onPatch: vi.fn(),
      })}`;

    const collapsed = renderInto(createProps({ editor: editor(false) }));
    const show = collapsed.querySelector<HTMLDetailsElement>("details.config-advanced-disclosure");
    expect(show?.open).toBe(false);
    expect(collapsed.textContent).not.toContain("Advanced memory field");
    show!.open = true;
    show!.dispatchEvent(new Event("toggle"));
    expect(onAdvancedChange).toHaveBeenCalledWith(true);

    const expanded = renderInto(createProps({ editor: editor(true) }));
    const hide = expanded.querySelector<HTMLDetailsElement>("details.config-advanced-disclosure");
    expect(hide?.open).toBe(true);
    expect(expanded.textContent).toContain("Advanced memory field");
    hide!.open = false;
    hide!.dispatchEvent(new Event("toggle"));
    expect(onAdvancedChange).toHaveBeenCalledWith(false);

    const overview = renderInto(createProps({ activeTab: "overview", editor: editor(false) }));
    expect(overview.querySelector("details.config-advanced-disclosure")).toBeNull();
  });
});

describe("memoryTabForRoute", () => {
  it("keeps old shared links working with the new destinations", () => {
    expect(memoryTabForRoute({ tab: "search" })).toBe("settings");
    expect(memoryTabForRoute({ tab: "dreaming" })).toBe("dreams");
    expect(memoryTabForRoute({ tab: "overview" })).toBe("overview");
    expect(memoryTabForRoute({ tab: "memories" })).toBe("memories");
    expect(memoryTabForRoute({ tab: "unknown" })).toBeNull();
  });

  it("routes old tabless schema links to Settings without changing the plain landing", () => {
    expect(memoryTabForRoute({ section: "memory", targetBlockId: "config-section-memory" })).toBe(
      "settings",
    );
    expect(memoryTabForRoute({ targetBlockId: "config-section-memory" })).toBe("settings");
    expect(memoryTabForRoute({})).toBeNull();
  });

  it("prefers an explicit canonical path over stale legacy route state", () => {
    expect(
      memoryTabForRoute({
        pathname: "/settings/memory/dreams",
        tab: "settings",
        section: "memory",
        targetBlockId: "config-section-memory",
      }),
    ).toBe("dreams");
    expect(memoryTabForRoute({ pathname: "/settings/memory" })).toBe("overview");
  });
});

describe("memorySchemaKeysForTab", () => {
  it("shows builtin memory settings only on Settings", () => {
    expect(memorySchemaKeysForTab("overview")).toEqual([]);
    expect(memorySchemaKeysForTab("memories")).toEqual([]);
    expect(memorySchemaKeysForTab("dreams")).toEqual([]);
    expect(memorySchemaKeysForTab("settings")).toEqual(["citations", "search"]);
  });
});

describe("memoryVisibleSchemaKeys", () => {
  it("matches the builtin Settings editor", () => {
    expect(memoryVisibleSchemaKeys()).toEqual(["citations", "search"]);
  });
});

describe("narrowMemorySchema", () => {
  const schema = {
    type: "object",
    properties: {
      memory: {
        type: "object",
        properties: {
          citations: { type: "string" },
          search: { type: "object" },
        },
      },
      tools: { type: "object" },
    },
  };

  it("keeps only the requested memory children and drops sibling sections", () => {
    const narrowed = narrowMemorySchema(schema, ["search"]) as {
      properties: { memory: { properties: Record<string, unknown> }; tools?: unknown };
    };

    expect(Object.keys(narrowed.properties)).toEqual(["memory"]);
    expect(Object.keys(narrowed.properties.memory.properties)).toEqual(["search"]);
  });

  it("returns a stable object per key set so schema analysis stays cached", () => {
    expect(narrowMemorySchema(schema, ["search"])).toBe(narrowMemorySchema(schema, ["search"]));
    expect(narrowMemorySchema(schema, ["search"])).not.toBe(
      narrowMemorySchema(schema, ["citations"]),
    );
  });

  it("passes non-memory schemas through untouched", () => {
    const unrelated = { type: "object", properties: { tools: {} } };
    expect(narrowMemorySchema(unrelated, ["search"])).toBe(unrelated);
    expect(narrowMemorySchema(null, ["search"])).toBeNull();
  });
});
