/* @vitest-environment jsdom */

import { html, render } from "lit";
import { describe, expect, it, vi } from "vitest";
import {
  memorySchemaKeysForTab,
  narrowMemorySchema,
  renderMemory,
  type MemoryViewProps,
} from "./memory.ts";

function createProps(overrides: Partial<MemoryViewProps> = {}): MemoryViewProps {
  return {
    activeTab: "overview",
    onTabChange: vi.fn(),
    engineOptions: [
      { id: "memory-core", label: "Memory Core" },
      { id: "memory-lancedb", label: "Memory LanceDB" },
    ],
    engineSelection: { kind: "auto", engineId: "memory-core" },
    engineBusy: false,
    engineError: null,
    onEngineChange: vi.fn(),
    backend: "builtin",
    backendBusy: false,
    onBackendChange: vi.fn(),
    addons: [
      { id: "active-memory", label: "Active memory", description: "Recent context", enabled: true },
      { id: "memory-wiki", label: "Memory wiki", description: "Wiki pages", enabled: false },
    ],
    pluginsHref: "/settings/plugins",
    memoryImportHref: "/memory-import",
    editor: html`<div class="test-editor"></div>`,
    dreaming: html`<div class="test-dreaming"></div>`,
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
    const link = container.querySelector<HTMLAnchorElement>("a.memory-page__link");
    expect(link?.getAttribute("href")).toBe("/settings/plugins");
  });

  it("keeps the schema editor on the overview and search tabs and swaps in dreaming", () => {
    expect(renderInto(createProps()).querySelector(".test-editor")).not.toBeNull();
    expect(
      renderInto(createProps({ activeTab: "search" })).querySelector(".test-editor"),
    ).not.toBeNull();

    const dreaming = renderInto(createProps({ activeTab: "dreaming" }));
    expect(dreaming.querySelector(".test-dreaming")).not.toBeNull();
    expect(dreaming.querySelector(".test-editor")).toBeNull();
  });
});

describe("memorySchemaKeysForTab", () => {
  it("reveals qmd sub-config only when qmd is the selected backend", () => {
    expect(memorySchemaKeysForTab("overview", "builtin")).toEqual(["citations"]);
    expect(memorySchemaKeysForTab("overview", "qmd")).toEqual(["citations", "qmd"]);
    expect(memorySchemaKeysForTab("search", "qmd")).toEqual(["search"]);
    // No applicable backend: qmd's sub-config belongs to a backend nothing reads.
    expect(memorySchemaKeysForTab("overview", null)).toEqual(["citations"]);
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
