/* @vitest-environment jsdom */

import { html, render } from "lit";
import { describe, expect, it, vi } from "vitest";
import {
  memorySchemaKeysForTab,
  memoryTabForRoute,
  memoryVisibleSchemaKeys,
  narrowMemorySchema,
  resolveMemoryBackend,
} from "./memory-schema.ts";
import { renderMemory } from "./memory.ts";

/** The view is the only public surface, so its props type comes from its signature. */
type MemoryViewProps = Parameters<typeof renderMemory>[0];

function createProps(overrides: Partial<MemoryViewProps> = {}): MemoryViewProps {
  return {
    activeTab: "settings",
    onTabChange: vi.fn(),
    engineOptions: [
      { id: "memory-core", label: "Memory Core" },
      { id: "memory-lancedb", label: "Memory LanceDB" },
    ],
    engineSelection: { kind: "auto", engineId: "memory-core" },
    engineState: "enabled",
    engineBusy: false,
    engineError: null,
    onEngineChange: vi.fn(),
    backend: "builtin",
    backendBusy: false,
    onBackendChange: vi.fn(),
    addons: [
      {
        id: "active-memory",
        label: "Active memory",
        description: "Recent context",
        state: "enabled",
      },
      { id: "memory-wiki", label: "Memory wiki", description: "Wiki pages", state: "disabled" },
    ],
    pluginsHref: "/settings/plugins",
    memoryImportHref: "/memory-import",
    overview: html`<div class="test-overview"></div>`,
    memories: html`<div class="test-memories"></div>`,
    dreams: html`<div class="test-dreams"></div>`,
    editor: html`<div class="test-editor"></div>`,
    dreamingSettings: html`<div class="test-dreaming-settings"></div>`,
    ...overrides,
  };
}

function renderInto(props: MemoryViewProps): HTMLElement {
  const container = document.createElement("div");
  render(renderMemory(props), container);
  return container;
}

describe("renderMemory", () => {
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

  it("reports whether the engine came from config or from the slot default", () => {
    const auto = renderInto(createProps());
    expect(auto.textContent).toContain("falls back to its default owner");

    const pinned = renderInto(
      createProps({ engineSelection: { kind: "pinned", engineId: "memory-core" } }),
    );
    expect(pinned.textContent).toContain("pinned in config");
  });

  it("surfaces a failed engine write next to the control", () => {
    expect(renderInto(createProps()).textContent).not.toContain("Could not change");

    const failed = renderInto(createProps({ engineError: "gateway rejected the change" }));
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

  it("hides the retrieval backend row for an engine that owns its own retrieval", () => {
    expect(renderInto(createProps({ backend: "builtin" })).textContent).toContain(
      "Retrieval backend",
    );
    expect(renderInto(createProps({ backend: null })).textContent).not.toContain(
      "Retrieval backend",
    );
  });

  it("renders add-on layering with per-plugin state and a Plugins link", () => {
    const container = renderInto(createProps());

    expect(container.textContent).toContain("Active memory");
    expect(container.textContent).toContain("Memory wiki");
    expect(container.textContent).toContain("Enabled");
    expect(container.textContent).toContain("Disabled");
    const link = container.querySelector<HTMLAnchorElement>("a.memory-page__link");
    expect(link?.getAttribute("href")).toBe("/settings/plugins");
  });

  it("never states an add-on is off while the catalog is unread", () => {
    for (const state of ["loading", "unknown"] as const) {
      const container = renderInto(
        createProps({
          addons: [{ id: "active-memory", label: "Active memory", description: "x", state }],
        }),
      );
      expect(container.textContent).not.toContain("Disabled");
      expect(container.textContent).not.toContain("Enabled");
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
    expect(memoryTabForRoute({ section: "memory", targetBlockId: "memory-backend" })).toBe(
      "settings",
    );
    expect(memoryTabForRoute({ targetBlockId: "config-section-memory" })).toBe("settings");
    expect(memoryTabForRoute({})).toBeNull();
  });
});

describe("memorySchemaKeysForTab", () => {
  it("reveals qmd sub-config only when qmd is the selected backend", () => {
    expect(memorySchemaKeysForTab("overview", "builtin")).toEqual([]);
    expect(memorySchemaKeysForTab("memories", "builtin")).toEqual([]);
    expect(memorySchemaKeysForTab("dreams", "qmd")).toEqual([]);
    expect(memorySchemaKeysForTab("settings", "builtin")).toEqual(["citations", "search"]);
    expect(memorySchemaKeysForTab("settings", "qmd")).toEqual(["citations", "qmd", "search"]);
    // No applicable backend: qmd's sub-config belongs to a backend nothing reads.
    expect(memorySchemaKeysForTab("settings", null)).toEqual(["citations", "search"]);
  });
});

describe("memoryVisibleSchemaKeys", () => {
  it("hides qmd until qmd is the selected backend and backend when no engine reads it", () => {
    expect([...memoryVisibleSchemaKeys("builtin")].toSorted()).toEqual([
      "backend",
      "citations",
      "search",
    ]);
    expect([...memoryVisibleSchemaKeys("qmd")].toSorted()).toEqual([
      "backend",
      "citations",
      "qmd",
      "search",
    ]);
    expect([...memoryVisibleSchemaKeys(null)].toSorted()).toEqual(["citations", "search"]);
  });
});

describe("resolveMemoryBackend", () => {
  it("reports a backend only for the memory-core slot owner", () => {
    expect(resolveMemoryBackend({})).toBe("builtin");
    expect(resolveMemoryBackend({ memory: { backend: "qmd" } })).toBe("qmd");
    // Another engine owns the slot, so nothing reads memory.backend.
    expect(
      resolveMemoryBackend({
        memory: { backend: "qmd" },
        plugins: { slots: { memory: "memory-lancedb" } },
      }),
    ).toBeNull();
    expect(resolveMemoryBackend({ plugins: { slots: { memory: "none" } } })).toBeNull();
  });
});

describe("narrowMemorySchema", () => {
  const schema = {
    type: "object",
    properties: {
      memory: {
        type: "object",
        properties: {
          backend: { type: "string" },
          citations: { type: "string" },
          search: { type: "object" },
          qmd: { type: "object" },
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
