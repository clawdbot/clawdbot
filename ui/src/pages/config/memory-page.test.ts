/* @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DoctorMemoryStatusPayload } from "../../../../src/gateway/server-methods/doctor.ts";
import { setPluginEnabled, type PluginCatalogItem } from "../../lib/plugins/index.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import {
  activeEngine,
  createMemoryTestAddon as addon,
  createMemoryTestDeferred as deferred,
  createMemoryTestEngine as engine,
  addonStatus,
  addonSwitch,
  createMemoryPage as createPage,
  memoryRoute,
  memoryTabRoute,
  selectEngine,
  toggleAddon,
} from "./memory-page.test-support.ts";
import type { ConfigRouteData } from "./route-data.ts";
import "./memory-page.ts";

vi.mock("../../lib/plugins/index.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/plugins/index.ts")>();
  return { ...actual, setPluginEnabled: vi.fn() };
});

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
  const target = element.querySelector(`#memory-tab-${tab}`);
  target?.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
  );
  target?.dispatchEvent(new MouseEvent("click", { detail: 0, bubbles: true }));
  dispatchTabShow(element, tab);
}

function dispatchTabShow(element: HTMLElement, tab: string) {
  element.querySelector("wa-tab-group")?.dispatchEvent(
    new CustomEvent("wa-tab-show", {
      detail: { name: tab },
      bubbles: true,
    }),
  );
}

describe("MemorySettingsPage engine slot", () => {
  it("resolves an unset slot to the slot default even when another engine is enabled", async () => {
    // resolveSlotSelection (src/plugins/slots.ts) makes an unset slot memory-core
    // regardless of catalog enablement, so the page must not report lancedb.
    const { element } = createPage({
      configObject: {},
      catalog: [
        engine("memory-lancedb", true, "Memory LanceDB"),
        engine("memory-core", false, "memory-core"),
      ],
    });
    document.body.append(element);
    try {
      await waitForFast(() => expect(activeEngine(element)).toBe("memory-core"));
      expect(element.textContent).toContain("falls back to its default owner");
      expect(
        [
          ...(element
            .querySelector("wa-radio-group.settings-segmented")
            ?.querySelectorAll("wa-radio") ?? []),
        ].map((radio) => radio.textContent?.trim()),
      ).toEqual(["OpenClaw Memory", "Memory LanceDB", "Off"]);
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

  it("persists Off and drains its autosave before re-enabling memory", async () => {
    const pendingWrites = deferred<void>();
    const patchForm = vi.fn();
    const setEnabled = vi.fn(() => Promise.resolve({}));
    const { element } = createPage({
      configObject: { plugins: { slots: { memory: "memory-lancedb" } } },
      catalog: [engine("memory-core", false), engine("memory-lancedb", true)],
      patchForm,
      waitForPendingWrites: () => pendingWrites.promise,
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

      selectEngine(element, "memory-core");
      await Promise.resolve();
      expect(setEnabled).not.toHaveBeenCalled();

      pendingWrites.resolve();
      await waitForFast(() => expect(setEnabled).toHaveBeenCalledOnce());
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
  beforeEach(() => {
    vi.mocked(setPluginEnabled).mockReset();
  });

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
      await waitForFast(() => expect(addonSwitch(element, "Active memory")?.checked).toBe(true));
      // Missing catalog entries are not installed, so the page must not offer a toggle.
      expect(addonStatus(element, "Memory wiki")).toBe("Unknown");
      expect(addonSwitch(element, "Memory wiki")).toBeNull();
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
      expect(addonStatus(element, "Active memory")).not.toBe("Disabled");
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
      await waitForFast(() => expect(addonSwitch(element, "Active memory")?.checked).toBe(true));

      first.resolve({ plugins: [addon("active-memory", false)] });
      await first.promise;
      await element.updateComplete;
      expect(addonSwitch(element, "Active memory")?.checked).toBe(true);
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
      await waitForFast(() => expect(addonSwitch(element, "Active memory")?.checked).toBe(true));
      setPhase("disconnected");
      await element.updateComplete;
      expect(addonStatus(element, "Active memory")).toBe("Unknown");
    } finally {
      element.remove();
    }
  });

  it("keeps a catalogued but not-installed add-on muted and non-interactive", async () => {
    const { element } = createPage({
      configObject: {},
      catalog: [
        {
          id: "active-memory",
          name: "active-memory",
          installed: false,
          enabled: false,
          state: "not-installed",
        } as PluginCatalogItem,
      ],
    });
    document.body.append(element);
    try {
      await waitForFast(() => expect(addonStatus(element, "Active memory")).toBe("Unknown"));
      expect(addonSwitch(element, "Active memory")).toBeNull();
    } finally {
      element.remove();
    }
  });

  it("falls back to read-only add-on status rows without operator.admin", async () => {
    const { element } = createPage({
      configObject: {},
      catalog: [addon("active-memory", true), addon("memory-wiki", false)],
      scopes: ["operator.read"],
    });
    document.body.append(element);
    try {
      await waitForFast(() => expect(addonStatus(element, "Active memory")).toBe("Enabled"));
      expect(addonStatus(element, "Memory wiki")).toBe("Disabled");
      expect(addonSwitch(element, "Active memory")).toBeNull();
      expect(addonSwitch(element, "Memory wiki")).toBeNull();
      expect(element.querySelector("a.memory-page__link")?.textContent).toContain("Open Plugins");
    } finally {
      element.remove();
    }
  });

  it("falls back to read-only add-on status rows when plugin mutations are unavailable", async () => {
    const { element } = createPage({
      configObject: {},
      catalog: [addon("active-memory", true), addon("memory-wiki", false)],
      mutationAllowed: false,
    });
    document.body.append(element);
    try {
      await waitForFast(() => expect(addonStatus(element, "Active memory")).toBe("Enabled"));
      expect(addonStatus(element, "Memory wiki")).toBe("Disabled");
      expect(addonSwitch(element, "Active memory")).toBeNull();
      expect(addonSwitch(element, "Memory wiki")).toBeNull();
      const engineGroup = element.querySelector<HTMLElement & { disabled?: boolean }>(
        "wa-radio-group.settings-segmented",
      );
      expect(engineGroup?.disabled).toBe(true);
    } finally {
      element.remove();
    }
  });

  it("toggles the requested add-on and refreshes config plus catalog on success", async () => {
    const refresh = vi.fn(() => Promise.resolve());
    const { element, request } = createPage({
      configObject: {},
      catalog: [addon("active-memory", true), addon("memory-wiki", false)],
      refresh,
    });
    document.body.append(element);
    try {
      await waitForFast(() => expect(addonSwitch(element, "Active memory")?.checked).toBe(true));
      toggleAddon(element, "Active memory", false);

      await waitForFast(() => expect(refresh).toHaveBeenCalledOnce());
      expect(setPluginEnabled).toHaveBeenCalledWith(expect.anything(), "active-memory", false);
      expect(request.mock.calls.filter(([method]) => method === "plugins.list")).toHaveLength(2);
    } finally {
      element.remove();
    }
  });

  it("ignores an older catalog reload from a parallel add-on mutation", async () => {
    const firstReload = deferred<{ plugins: readonly PluginCatalogItem[] }>();
    const secondReload = deferred<{ plugins: readonly PluginCatalogItem[] }>();
    const initial = [addon("active-memory", true), addon("memory-wiki", false)];
    const { element, request } = createPage({
      configObject: {},
      listCatalog: (call) => {
        if (call === 0) {
          return Promise.resolve({ plugins: initial });
        }
        return call === 1 ? firstReload.promise : secondReload.promise;
      },
    });
    document.body.append(element);
    try {
      await waitForFast(() => expect(addonSwitch(element, "Active memory")?.checked).toBe(true));
      toggleAddon(element, "Active memory", false);
      toggleAddon(element, "Memory wiki", true);
      await waitForFast(() =>
        expect(request.mock.calls.filter(([method]) => method === "plugins.list")).toHaveLength(3),
      );

      secondReload.resolve({
        plugins: [addon("active-memory", false), addon("memory-wiki", true)],
      });
      await waitForFast(() => expect(addonSwitch(element, "Memory wiki")?.checked).toBe(true));

      firstReload.resolve({
        plugins: [addon("active-memory", false), addon("memory-wiki", false)],
      });
      await firstReload.promise;
      await element.updateComplete;
      expect(addonSwitch(element, "Memory wiki")?.checked).toBe(true);
    } finally {
      element.remove();
    }
  });

  it("does not let a stale mutation supersede a reconnect catalog reload", async () => {
    const mutation = deferred<unknown>();
    const mutationReload = deferred<{ plugins: readonly PluginCatalogItem[] }>();
    const initial = [addon("active-memory", true), addon("memory-wiki", false)];
    const { element, request, setPhase } = createPage({
      configObject: {},
      listCatalog: (call) =>
        call < 2 ? Promise.resolve({ plugins: initial }) : mutationReload.promise,
      setEnabled: () => mutation.promise,
    });
    document.body.append(element);
    try {
      await waitForFast(() => expect(addonSwitch(element, "Active memory")?.checked).toBe(true));
      toggleAddon(element, "Active memory", false);
      await waitForFast(() => expect(setPluginEnabled).toHaveBeenCalledOnce());

      setPhase("disconnected");
      setPhase("connected");
      await waitForFast(() =>
        expect(request.mock.calls.filter(([method]) => method === "plugins.list")).toHaveLength(2),
      );

      mutation.resolve({});
      await waitForFast(() =>
        expect(request.mock.calls.filter(([method]) => method === "plugins.list")).toHaveLength(3),
      );

      mutationReload.resolve({
        plugins: [addon("active-memory", false), addon("memory-wiki", false)],
      });
      await waitForFast(() => expect(addonSwitch(element, "Active memory")?.checked).toBe(false));
    } finally {
      element.remove();
    }
  });

  it("keeps a committed add-on change successful while making its failed refresh visible", async () => {
    const refresh = vi.fn(() => Promise.reject(new Error("config refresh failed")));
    const initial = [addon("active-memory", true), addon("memory-wiki", false)];
    const updated = [addon("active-memory", false), addon("memory-wiki", false)];
    const { element } = createPage({
      configObject: {},
      listCatalog: (call) => Promise.resolve({ plugins: call === 0 ? initial : updated }),
      refresh,
    });
    document.body.append(element);
    try {
      await waitForFast(() => expect(addonSwitch(element, "Active memory")?.checked).toBe(true));
      toggleAddon(element, "Active memory", false);

      await waitForFast(() => expect(refresh).toHaveBeenCalledOnce());
      await waitForFast(() => expect(element.textContent).toContain("config refresh failed"));
      await waitForFast(() => expect(addonSwitch(element, "Active memory")?.checked).toBe(false));
      expect(element.textContent).toContain("Needs attention");
      expect(element.textContent).not.toContain("Could not update Active memory");
    } finally {
      element.remove();
    }
  });

  it("surfaces restart-required outcomes from add-on mutations", async () => {
    const initial = [addon("active-memory", true), addon("memory-wiki", false)];
    const updated = [addon("active-memory", true), addon("memory-wiki", true)];
    let mutations = 0;
    const { element, request, setPhase } = createPage({
      configObject: {},
      listCatalog: (call) => Promise.resolve({ plugins: call === 0 ? initial : updated }),
      setEnabled: (_pluginId, enabled) =>
        mutations++ === 0
          ? Promise.resolve({
              ok: true,
              plugin: addon("memory-wiki", enabled),
              restartRequired: true,
            })
          : Promise.reject(new Error("follow-up rejected")),
      processInstanceIds: [undefined, "process-a", "process-a", "process-a", "process-b"],
    });
    document.body.append(element);
    try {
      await waitForFast(() => expect(addonSwitch(element, "Memory wiki")?.checked).toBe(false));
      toggleAddon(element, "Memory wiki", true);

      await waitForFast(() => expect(element.textContent).toContain("Needs attention"));
      expect(element.textContent).toContain(
        "Enabled memory-wiki. A Gateway restart is required to apply the change.",
      );
      expect(addonSwitch(element, "Memory wiki")?.checked).toBe(true);

      toggleAddon(element, "Memory wiki", false);
      await waitForFast(() => expect(element.textContent).toContain("follow-up rejected"));
      expect(element.textContent).toContain(
        "Enabled memory-wiki. A Gateway restart is required to apply the change.",
      );

      setPhase("disconnected");
      setPhase("connected");
      await waitForFast(() =>
        expect(request.mock.calls.filter(([method]) => method === "system.info")).toHaveLength(4),
      );
      expect(element.textContent).toContain(
        "Enabled memory-wiki. A Gateway restart is required to apply the change.",
      );

      setPhase("disconnected");
      setPhase("connected");
      await waitForFast(() =>
        expect(element.textContent).not.toContain(
          "Enabled memory-wiki. A Gateway restart is required to apply the change.",
        ),
      );
    } finally {
      element.remove();
    }
  });

  it("disables only the add-on whose mutation is in flight", async () => {
    const pending = deferred<unknown>();
    const { element } = createPage({
      configObject: {},
      catalog: [addon("active-memory", true), addon("memory-wiki", false)],
      setEnabled: () => pending.promise,
    });
    document.body.append(element);
    try {
      await waitForFast(() => expect(addonSwitch(element, "Active memory")).not.toBeNull());
      toggleAddon(element, "Active memory", false);

      await waitForFast(() =>
        expect(addonSwitch(element, "Active memory")?.hasAttribute("disabled")).toBe(true),
      );
      expect(addonSwitch(element, "Memory wiki")?.hasAttribute("disabled")).toBe(false);
      pending.resolve({});
    } finally {
      element.remove();
    }
  });

  it("renders and clears mutation errors on only the affected add-on", async () => {
    const retry = deferred<unknown>();
    let attempts = 0;
    const { element } = createPage({
      configObject: {},
      catalog: [addon("active-memory", true), addon("memory-wiki", false)],
      setEnabled: () =>
        attempts++ === 0 ? Promise.reject(new Error("enablement rejected")) : retry.promise,
    });
    document.body.append(element);
    try {
      await waitForFast(() => expect(addonSwitch(element, "Active memory")).not.toBeNull());
      toggleAddon(element, "Active memory", false);
      await waitForFast(() => expect(element.textContent).toContain("enablement rejected"));
      expect(addonSwitch(element, "Active memory")?.checked).toBe(true);
      expect(element.textContent).toContain("Could not update Active memory");
      expect(element.textContent).not.toContain("Could not update Memory wiki");

      toggleAddon(element, "Active memory", false);
      await waitForFast(() => expect(element.textContent).not.toContain("enablement rejected"));
      retry.resolve({});
    } finally {
      element.remove();
    }
  });
});

describe("MemorySettingsPage tab routing", () => {
  it("keeps the nested Dreams hosts out of the Memory page layout", async () => {
    const { element } = createPage({
      configObject: {},
      catalog: [],
      routeData: memoryTabRoute("dreams"),
    });
    document.body.append(element);
    try {
      await waitForFast(() =>
        expect(element.querySelector("openclaw-agent-memory-panel")).not.toBeNull(),
      );

      expect(element.style.display).toBe("contents");
      expect(element.querySelector<HTMLElement>("openclaw-memory-dreaming")?.style.display).toBe(
        "contents",
      );
      expect(element.querySelector<HTMLElement>("openclaw-agent-memory-panel")?.style.display).toBe(
        "contents",
      );
    } finally {
      element.remove();
    }
  });

  it("probes embeddings through the guarded overview request and renders the result", async () => {
    const probe = deferred<DoctorMemoryStatusPayload>();
    const initial: DoctorMemoryStatusPayload = {
      agentId: "main",
      provider: "local",
      embedding: { ok: false, checked: false },
    };
    const { element, request } = createPage({
      configObject: {},
      memoryStatus: (_agentId, shouldProbe) =>
        shouldProbe ? probe.promise : Promise.resolve(initial),
    });
    element.routeData = memoryTabRoute("overview");
    document.body.append(element);
    try {
      await waitForFast(() =>
        expect(
          [...element.querySelectorAll<HTMLButtonElement>("button")].some(
            (button) => button.textContent?.trim() === "Test",
          ),
        ).toBe(true),
      );
      const testButton = [...element.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent?.trim() === "Test",
      );
      testButton?.click();

      await waitForFast(() =>
        expect(request).toHaveBeenCalledWith("doctor.memory.status", {
          agentId: "main",
          probe: true,
        }),
      );
      await waitForFast(() =>
        expect(
          [...element.querySelectorAll<HTMLButtonElement>("button")].find(
            (button) => button.textContent?.trim() === "Testing…",
          )?.disabled,
        ).toBe(true),
      );

      probe.resolve({
        agentId: "main",
        provider: "local",
        embedding: { ok: false, checked: true, error: "embedding probe failed" },
      });
      await waitForFast(() => expect(element.textContent).toContain("embedding probe failed"));
      expect(
        [...element.querySelectorAll<HTMLButtonElement>("button")].some(
          (button) => button.textContent?.trim() === "Test",
        ),
      ).toBe(false);
    } finally {
      element.remove();
    }
  });

  it("renders every canonical tab path and honors browser history restoration", async () => {
    const navigate = vi.fn();
    const { element } = createPage({ configObject: {}, catalog: [], navigate });
    element.routeData = memoryTabRoute("settings");
    document.body.append(element);
    try {
      await element.updateComplete;
      expect(visibleTab(element)).toBe("settings");

      // A manual click rewrites the URL rather than shadowing it with local state.
      selectTab(element, "overview");
      expect(navigate).toHaveBeenCalledWith("memory", { pathname: "/settings/memory" });
      element.routeData = memoryTabRoute("overview");
      await element.updateComplete;
      expect(visibleTab(element)).toBe("overview");

      // The router feeding an older history entry back must restore that tab.
      element.routeData = memoryTabRoute("settings");
      await element.updateComplete;
      expect(visibleTab(element)).toBe("settings");

      element.routeData = memoryTabRoute("memories");
      await element.updateComplete;
      expect(visibleTab(element)).toBe("memories");

      element.routeData = memoryTabRoute("dreams");
      await element.updateComplete;
      expect(visibleTab(element)).toBe("dreams");
    } finally {
      element.remove();
    }
  });

  it("writes the chosen tab into the URL so history restores it", async () => {
    const navigate = vi.fn();
    const { element } = createPage({ configObject: {}, catalog: [], navigate });
    element.routeData = memoryTabRoute("overview");
    document.body.append(element);
    try {
      await element.updateComplete;
      expect(visibleTab(element)).toBe("overview");

      selectTab(element, "dreams");
      expect(navigate).toHaveBeenCalledWith("memory", { pathname: "/settings/memory/dreams" });
      // Nothing moves until the router feeds the new tab back in.
      await element.updateComplete;
      expect(visibleTab(element)).toBe("overview");

      selectTab(element, "memories");
      expect(navigate).toHaveBeenCalledWith("memory", {
        pathname: "/settings/memory/memories",
      });
    } finally {
      element.remove();
    }
  });

  it("handles Space directly so the browser cannot synthesize a second navigation", async () => {
    const navigate = vi.fn();
    const { element } = createPage({ configObject: {}, catalog: [], navigate });
    element.routeData = memoryTabRoute("overview");
    document.body.append(element);
    try {
      await element.updateComplete;
      const space = new KeyboardEvent("keydown", {
        key: " ",
        bubbles: true,
        cancelable: true,
      });
      element.querySelector("#memory-tab-dreams")?.dispatchEvent(space);

      expect(space.defaultPrevented).toBe(true);
      expect(navigate).toHaveBeenCalledOnce();
      expect(navigate).toHaveBeenCalledWith("memory", {
        pathname: "/settings/memory/dreams",
      });
    } finally {
      element.remove();
    }
  });

  it.each([
    ["/settings/memory", null],
    ["/settings/memory/memories", null],
    ["/settings/memory/dreams", null],
    ["/settings/memory/settings", null],
    ["/settings/memory?tab=memories", "/settings/memory/memories"],
    ["/settings/memory?tab=dreams", "/settings/memory/dreams"],
    ["/settings/memory?tab=settings", "/settings/memory/settings"],
    ["/settings/memory?tab=dreaming", "/settings/memory/dreams"],
    ["/settings/memory?tab=search", "/settings/memory/settings"],
    ["/settings/memory?tab=overview", "/settings/memory"],
    ["/settings/memory?section=memory", "/settings/memory/settings"],
    ["/settings/memory#config-section-memory", "/settings/memory/settings#config-section-memory"],
    [
      "/settings/memory#config-section-memory-search",
      "/settings/memory/settings#config-section-memory-search",
    ],
  ] as const)(
    "performs at most one replace for %s and never oscillates back to a query tab",
    async (sourceUrl, expectedUrl) => {
      const replace = vi.fn();
      const navigate = vi.fn();
      const { element } = createPage({
        configObject: {},
        catalog: [],
        replace,
        navigate,
        routeData: memoryRoute(sourceUrl),
      });
      document.body.append(element);
      try {
        await element.updateComplete;
        for (let cycle = 0; cycle < 3; cycle += 1) {
          element.routeData = { ...element.routeData } as ConfigRouteData;
          await element.updateComplete;
        }
        dispatchTabShow(element, "overview");
        dispatchTabShow(element, "dreams");

        expect(replace).toHaveBeenCalledTimes(expectedUrl ? 1 : 0);
        expect(navigate).not.toHaveBeenCalled();
        if (!expectedUrl) {
          return;
        }
        const canonical = memoryRoute(expectedUrl);
        expect(replace).toHaveBeenCalledWith("memory", {
          pathname: canonical.pathname,
          search: canonical.search,
          hash: canonical.hash,
        });

        element.routeData = canonical;
        await element.updateComplete;
        for (let cycle = 0; cycle < 3; cycle += 1) {
          element.routeData = { ...element.routeData } as ConfigRouteData;
          await element.updateComplete;
        }
        expect(replace).toHaveBeenCalledOnce();
      } finally {
        element.remove();
      }
    },
  );

  it("loads Overview status once per activation, header agent change, and reconnect", async () => {
    const memoryStatus = vi.fn((agentId: string) =>
      Promise.resolve({ agentId, provider: "none", embedding: { ok: false, checked: false } }),
    );
    const { element, request, setPhase } = createPage({
      configObject: {},
      agents: [{ id: "main" }, { id: "research" }],
      memoryStatus,
    });
    element.routeData = memoryTabRoute("overview");
    document.body.append(element);
    try {
      await waitForFast(() => expect(memoryStatus).toHaveBeenCalledTimes(1));
      await element.updateComplete;
      expect(
        request.mock.calls.filter(([method]) => method === "doctor.memory.status"),
      ).toHaveLength(1);

      expect(element.querySelectorAll("openclaw-agent-select")).toHaveLength(1);
      expect(element.textContent).not.toContain("Agent view");
      const select = element.querySelector(
        ".hub-page-header__actions openclaw-agent-select",
      ) as HTMLElement & {
        onSelect?: (value: string) => void;
      };
      select.onSelect?.("research");
      await waitForFast(() => expect(memoryStatus).toHaveBeenLastCalledWith("research", false));

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
    element.routeData = memoryTabRoute("overview");
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
      element.routeData = memoryTabRoute("overview");
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
  it("links the dreaming intro to its guide", async () => {
    const { element } = createPage({
      configObject: {},
      routeData: memoryTabRoute("settings"),
    });
    document.body.append(element);
    try {
      await waitForFast(() =>
        expect(
          element.querySelector(
            '.settings-page__intro a[href="https://docs.openclaw.ai/concepts/dreaming"]',
          ),
        ).not.toBeNull(),
      );
      const link = element.querySelector<HTMLAnchorElement>(
        '.settings-page__intro a[href="https://docs.openclaw.ai/concepts/dreaming"]',
      );

      expect(link?.textContent?.trim()).toBe("Learn more");
      expect(link?.href).toBe("https://docs.openclaw.ai/concepts/dreaming");
    } finally {
      element.remove();
    }
  });

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
