/* @vitest-environment jsdom */

import { describe, expect, it, vi } from "vitest";
import type { ApplicationContext } from "../../app/context.ts";
import type { PluginCatalogItem } from "../../lib/plugins/index.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import "./memory-page.ts";

type MemoryPageElement = HTMLElement & {
  configObject: Record<string, unknown>;
  updateComplete: Promise<unknown>;
};

function engine(id: string, enabled: boolean): PluginCatalogItem {
  return {
    id,
    name: id,
    installed: true,
    enabled,
    kind: ["memory"],
  } as unknown as PluginCatalogItem;
}

function createPage(params: {
  configObject: Record<string, unknown>;
  catalog: readonly PluginCatalogItem[];
  patchForm?: (path: Array<string | number>, value: unknown) => void;
  setEnabled?: () => Promise<unknown>;
}) {
  const request = vi.fn((method: string) => {
    if (method === "plugins.list") {
      return Promise.resolve({ plugins: params.catalog });
    }
    return params.setEnabled ? params.setEnabled() : Promise.resolve({});
  });
  const element = document.createElement("openclaw-memory-settings") as MemoryPageElement;
  element.configObject = params.configObject;
  (element as unknown as { context: ApplicationContext }).context = {
    gateway: {
      snapshot: { client: { request }, phase: "connected" },
      subscribe: () => () => undefined,
    },
    runtimeConfig: {
      state: { configSaving: false, configApplying: false },
      patchForm: params.patchForm ?? vi.fn(),
      refresh: () => Promise.resolve(),
    },
  } as unknown as ApplicationContext;
  return { element, request };
}

function activeEngine(element: HTMLElement): string | null {
  return (
    element.querySelector("wa-radio.settings-segmented__btn--active")?.getAttribute("value") ?? null
  );
}

function selectEngine(element: HTMLElement, value: string) {
  const group = element.querySelector("wa-radio-group") as HTMLElement & { value?: string };
  group.value = value;
  group.dispatchEvent(new Event("change"));
}

describe("MemorySettingsPage engine slot", () => {
  it("resolves an unset slot to the slot default even when another engine is enabled", async () => {
    // resolveSlotSelection (src/plugins/slots.ts) makes an unset slot memory-core
    // regardless of catalog enablement, so the page must not report lancedb.
    const { element } = createPage({
      configObject: {},
      catalog: [engine("memory-core", false), engine("memory-lancedb", true)],
    });
    document.body.append(element);
    try {
      await waitForFast(() => expect(activeEngine(element)).toBe("memory-core"));
      expect(element.textContent).toContain("falls back to its default owner");
    } finally {
      element.remove();
    }
  });

  it("persists Off as the none slot so it survives a config refresh", async () => {
    const patchForm = vi.fn();
    const setEnabled = vi.fn(() => Promise.resolve({}));
    const { element } = createPage({
      configObject: { plugins: { slots: { memory: "memory-lancedb" } } },
      catalog: [engine("memory-core", false), engine("memory-lancedb", true)],
      patchForm,
      setEnabled,
    });
    document.body.append(element);
    try {
      await waitForFast(() => expect(activeEngine(element)).toBe("memory-lancedb"));

      selectEngine(element, "");
      // Disabling the plugin would leave the slot pinned; only the explicit
      // sentinel makes Off outlive a reload.
      expect(patchForm).toHaveBeenCalledWith(["plugins", "slots", "memory"], "none");
      expect(setEnabled).not.toHaveBeenCalled();

      // Round-trip: the reloaded config carries the write back into the page.
      element.configObject = { plugins: { slots: { memory: "none" } } };
      await element.updateComplete;
      expect(activeEngine(element)).toBe("");
      expect(element.textContent).toContain("switched off");
    } finally {
      element.remove();
    }
  });

  it("reports a rejected engine change instead of silently snapping back", async () => {
    const { element } = createPage({
      configObject: {},
      catalog: [engine("memory-core", true), engine("memory-lancedb", false)],
      setEnabled: () => Promise.reject(new Error("plugin not installed: memory-lancedb")),
    });
    document.body.append(element);
    try {
      await waitForFast(() => expect(activeEngine(element)).toBe("memory-core"));

      selectEngine(element, "memory-lancedb");
      await waitForFast(() =>
        expect(element.textContent).toContain("plugin not installed: memory-lancedb"),
      );
      expect(element.textContent).toContain("Could not change the memory engine");
    } finally {
      element.remove();
    }
  });
});
