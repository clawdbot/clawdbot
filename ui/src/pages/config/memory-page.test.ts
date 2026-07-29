/* @vitest-environment jsdom */

import { describe, expect, it, vi } from "vitest";
import type { ApplicationContext } from "../../app/context.ts";
import type { PluginCatalogItem } from "../../lib/plugins/index.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import "./memory-page.ts";

type MemoryPageElement = HTMLElement & {
  configObject: Record<string, unknown>;
  tab: string | null;
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

function addon(id: string, enabled: boolean): PluginCatalogItem {
  return { id, name: id, installed: true, enabled } as unknown as PluginCatalogItem;
}

function createPage(params: {
  configObject: Record<string, unknown>;
  /** Resolves one `plugins.list` call; the default answers every call with `catalog`. */
  listCatalog?: (call: number) => Promise<{ plugins: readonly PluginCatalogItem[] }>;
  catalog?: readonly PluginCatalogItem[];
  patchForm?: (path: Array<string | number>, value: unknown) => void;
  setEnabled?: () => Promise<unknown>;
  navigate?: (routeId: string, options?: { search?: string }) => void;
  agents?: Array<{ id: string; name?: string }>;
  memoryStatus?: (agentId: string) => Promise<unknown>;
  lookupSchemaPath?: (call: number) => Promise<unknown>;
}) {
  let listCalls = 0;
  let schemaLookups = 0;
  const request = vi.fn((method: string, payload?: { agentId?: string }) => {
    if (method === "plugins.list") {
      const call = listCalls++;
      return params.listCatalog
        ? params.listCatalog(call)
        : Promise.resolve({ plugins: params.catalog ?? [] });
    }
    if (method === "doctor.memory.status") {
      return params.memoryStatus
        ? params.memoryStatus(payload?.agentId ?? "main")
        : Promise.resolve({
            agentId: payload?.agentId ?? "main",
            provider: "none",
            embedding: { ok: false, checked: false },
          });
    }
    return params.setEnabled ? params.setEnabled() : Promise.resolve({});
  });
  const gatewayListeners = new Set<() => void>();
  const runtimeListeners = new Set<() => void>();
  const gateway = {
    snapshot: { client: { request }, phase: "connected" },
    subscribe: (notify: () => void) => {
      gatewayListeners.add(notify);
      return () => gatewayListeners.delete(notify);
    },
  };
  const element = document.createElement("openclaw-memory-settings") as MemoryPageElement;
  element.configObject = params.configObject;
  element.tab = "settings";
  const runtimeConfig = {
    state: {
      client: {},
      connected: true,
      configSaving: false,
      configApplying: false,
      configForm: params.configObject,
      configSnapshot: null,
    },
    subscribe: (notify: () => void) => {
      runtimeListeners.add(notify);
      return () => runtimeListeners.delete(notify);
    },
    lookupSchemaPath: vi.fn(() =>
      params.lookupSchemaPath
        ? params.lookupSchemaPath(schemaLookups++)
        : Promise.resolve({ type: "object" }),
    ),
    patchForm: params.patchForm ?? vi.fn(),
    removeFormValue: vi.fn(),
    refresh: () => Promise.resolve(),
  };
  (element as unknown as { context: ApplicationContext }).context = {
    gateway,
    runtimeConfig,
    agents: {
      state: {
        agentsList: {
          defaultId: params.agents?.[0]?.id ?? "main",
          agents: params.agents ?? [{ id: "main" }],
        },
        agentsLoading: false,
      },
      subscribe: () => () => undefined,
      ensureList: () => Promise.resolve(),
    },
    navigate: params.navigate ?? vi.fn(),
  } as unknown as ApplicationContext;
  const setPhase = (phase: string) => {
    gateway.snapshot = { ...gateway.snapshot, phase };
    runtimeConfig.state = { ...runtimeConfig.state, connected: phase === "connected" };
    for (const notify of gatewayListeners) {
      notify();
    }
    for (const notify of runtimeListeners) {
      notify();
    }
  };
  return { element, request, setPhase, lookupSchemaPath: runtimeConfig.lookupSchemaPath };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function addonStatus(element: HTMLElement, label: string): string | null {
  const row = [...element.querySelectorAll(".settings-row")].find((entry) =>
    entry.textContent?.includes(label),
  );
  return row?.querySelector(".settings-status")?.textContent?.trim() ?? null;
}

/** Which tab body is actually mounted, rather than what the tab strip claims. */
function visibleTab(element: HTMLElement): "overview" | "memories" | "dreams" | "settings" | null {
  const panel = element.querySelector('[role="tabpanel"]');
  if (!panel) {
    return null;
  }
  if (panel.querySelector("openclaw-memory-dreaming")) {
    return "dreams";
  }
  if (panel.querySelector("openclaw-memory-memories")) {
    return "memories";
  }
  return panel.querySelector(".memory-overview") ? "overview" : "settings";
}

function selectTab(element: HTMLElement, tab: string) {
  element
    .querySelector("wa-tab-group")
    ?.dispatchEvent(new CustomEvent("wa-tab-show", { detail: { name: tab }, bubbles: true }));
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

  it("offers an enable action when the slot owner is disabled", async () => {
    const setEnabled = vi.fn(() => Promise.resolve({}));
    const { element } = createPage({
      configObject: {},
      catalog: [engine("memory-core", false)],
      setEnabled,
    });
    document.body.append(element);
    try {
      await waitForFast(() => expect(element.textContent).toContain("This engine is disabled"));

      // The control already shows memory-core selected, so re-picking it fires no
      // change event; without this button the owner could never be re-enabled.
      const enable = [...element.querySelectorAll("button")].find(
        (button) => button.textContent?.trim() === "Enable",
      );
      enable?.click();
      await waitForFast(() => expect(setEnabled).toHaveBeenCalled());
    } finally {
      element.remove();
    }
  });

  it("keeps the enable action hidden once the owner is running", async () => {
    const { element } = createPage({
      configObject: {},
      catalog: [engine("memory-core", true)],
    });
    document.body.append(element);
    try {
      await waitForFast(() => expect(activeEngine(element)).toBe("memory-core"));
      expect(element.textContent).not.toContain("This engine is disabled");
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

describe("MemorySettingsPage catalog state", () => {
  it("does not claim an add-on is disabled before the catalog is read", async () => {
    const pending = deferred<{ plugins: readonly PluginCatalogItem[] }>();
    const { element } = createPage({
      configObject: {},
      listCatalog: () => pending.promise,
    });
    document.body.append(element);
    try {
      await element.updateComplete;
      // The catalog is still in flight: "Disabled" here would be a definite claim
      // about a plugin whose entry was never read.
      expect(addonStatus(element, "Active memory")).toBe("Loading…");

      pending.resolve({ plugins: [addon("active-memory", true)] });
      await waitForFast(() => expect(addonStatus(element, "Active memory")).toBe("Enabled"));
      // A read that succeeded but has no entry really does mean not enabled.
      expect(addonStatus(element, "Memory wiki")).toBe("Disabled");
    } finally {
      element.remove();
    }
  });

  it("reports unknown add-on state instead of disabled once the catalog read fails", async () => {
    const { element } = createPage({
      configObject: {},
      listCatalog: () => Promise.reject(new Error("gateway is gone")),
    });
    document.body.append(element);
    try {
      await waitForFast(() => expect(addonStatus(element, "Active memory")).toBe("Unknown"));
      expect(element.textContent).not.toContain("Disabled");
    } finally {
      element.remove();
    }
  });

  it("drops a catalog completion from a superseded connection", async () => {
    const first = deferred<{ plugins: readonly PluginCatalogItem[] }>();
    const second = deferred<{ plugins: readonly PluginCatalogItem[] }>();
    const { element, setPhase } = createPage({
      configObject: {},
      listCatalog: (call) => (call === 0 ? first.promise : second.promise),
    });
    document.body.append(element);
    try {
      await element.updateComplete;
      // Same client object survives the drop and the reconnect, so only the
      // per-connection request generation can tell the two loads apart.
      setPhase("disconnected");
      setPhase("connected");
      await waitForFast(() => expect(addonStatus(element, "Active memory")).toBe("Loading…"));

      second.resolve({ plugins: [addon("active-memory", true)] });
      await waitForFast(() => expect(addonStatus(element, "Active memory")).toBe("Enabled"));

      first.resolve({ plugins: [addon("active-memory", false)] });
      await first.promise;
      await element.updateComplete;
      expect(addonStatus(element, "Active memory")).toBe("Enabled");
    } finally {
      element.remove();
    }
  });

  it("marks add-ons unknown while disconnected", async () => {
    const { element, setPhase } = createPage({
      configObject: {},
      catalog: [addon("active-memory", true)],
    });
    document.body.append(element);
    try {
      await waitForFast(() => expect(addonStatus(element, "Active memory")).toBe("Enabled"));
      setPhase("disconnected");
      await element.updateComplete;
      expect(addonStatus(element, "Active memory")).toBe("Unknown");
    } finally {
      element.remove();
    }
  });
});

describe("MemorySettingsPage tab routing", () => {
  it("honors every ?tab= arrival, including a repeat after a manual tab change", async () => {
    const navigate = vi.fn();
    const { element } = createPage({ configObject: {}, catalog: [], navigate });
    element.tab = "settings";
    document.body.append(element);
    try {
      await element.updateComplete;
      expect(visibleTab(element)).toBe("settings");

      // A manual click rewrites the URL rather than shadowing it with local state.
      selectTab(element, "overview");
      expect(navigate).toHaveBeenCalledWith("memory", undefined);
      element.tab = null;
      await element.updateComplete;
      expect(visibleTab(element)).toBe("overview");

      // Same intent as the first arrival: an adopt-once page would ignore this.
      element.tab = "settings";
      await element.updateComplete;
      expect(visibleTab(element)).toBe("settings");

      element.tab = "memories";
      await element.updateComplete;
      expect(visibleTab(element)).toBe("memories");
    } finally {
      element.remove();
    }
  });

  it("writes the chosen tab into the URL so history restores it", async () => {
    const navigate = vi.fn();
    const { element } = createPage({ configObject: {}, catalog: [], navigate });
    element.tab = "overview";
    document.body.append(element);
    try {
      await element.updateComplete;
      expect(visibleTab(element)).toBe("overview");

      selectTab(element, "dreams");
      expect(navigate).toHaveBeenCalledWith("memory", { search: "?tab=dreams" });
      // Nothing moves until the router feeds the new tab back in.
      await element.updateComplete;
      expect(visibleTab(element)).toBe("overview");

      selectTab(element, "memories");
      expect(navigate).toHaveBeenCalledWith("memory", { search: "?tab=memories" });
    } finally {
      element.remove();
    }
  });

  it("loads Overview status once per activation, agent change, and reconnect", async () => {
    const memoryStatus = vi.fn((agentId: string) =>
      Promise.resolve({ agentId, provider: "none", embedding: { ok: false, checked: false } }),
    );
    const { element, request, setPhase } = createPage({
      configObject: {},
      agents: [{ id: "main" }, { id: "research" }],
      memoryStatus,
    });
    element.tab = "overview";
    document.body.append(element);
    try {
      await waitForFast(() => expect(memoryStatus).toHaveBeenCalledTimes(1));
      await element.updateComplete;
      expect(
        request.mock.calls.filter(([method]) => method === "doctor.memory.status"),
      ).toHaveLength(1);

      const select = element.querySelector("openclaw-agent-select") as HTMLElement & {
        onSelect?: (value: string) => void;
      };
      select.onSelect?.("research");
      await waitForFast(() => expect(memoryStatus).toHaveBeenLastCalledWith("research"));

      setPhase("disconnected");
      setPhase("connected");
      await waitForFast(() => expect(memoryStatus).toHaveBeenCalledTimes(3));
    } finally {
      element.remove();
    }
  });

  it("reloads status when one pinned engine replaces another", async () => {
    const memoryStatus = vi.fn((agentId: string) =>
      Promise.resolve({ agentId, provider: "none", embedding: { ok: false, checked: false } }),
    );
    const { element } = createPage({
      configObject: { plugins: { slots: { memory: "engine-a" } } },
      catalog: [engine("engine-a", true), engine("engine-b", true)],
      memoryStatus,
    });
    element.tab = "overview";
    document.body.append(element);
    try {
      await waitForFast(() => expect(memoryStatus).toHaveBeenCalledTimes(1));

      element.configObject = { plugins: { slots: { memory: "engine-b" } } };
      await waitForFast(() => expect(memoryStatus).toHaveBeenCalledTimes(2));
      expect(element.textContent).toContain("engine-b");
    } finally {
      element.remove();
    }
  });

  it("shows the offline state when Overview is activated after disconnecting elsewhere", async () => {
    const { element, setPhase } = createPage({ configObject: {} });
    document.body.append(element);
    try {
      await element.updateComplete;
      setPhase("disconnected");
      element.tab = "overview";
      await waitForFast(() =>
        expect(element.textContent).toContain(
          "The gateway is offline, so memory status is unavailable.",
        ),
      );
    } finally {
      element.remove();
    }
  });
});

describe("MemorySettingsPage dreaming support", () => {
  it("re-probes after reconnect and drops the abandoned capability result", async () => {
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    const { element, lookupSchemaPath, setPhase } = createPage({
      configObject: {},
      lookupSchemaPath: (call) => (call === 0 ? first.promise : second.promise),
    });
    document.body.append(element);
    try {
      await waitForFast(() => expect(lookupSchemaPath).toHaveBeenCalledTimes(1));

      setPhase("disconnected");
      setPhase("connected");
      await waitForFast(() => expect(lookupSchemaPath).toHaveBeenCalledTimes(2));

      first.resolve({ type: "object", additionalProperties: false, properties: {} });
      await first.promise;
      await element.updateComplete;
      expect(element.textContent).not.toContain("Not available for this engine");

      second.resolve({ type: "object" });
    } finally {
      element.remove();
    }
  });
});
