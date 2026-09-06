/* @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { setPluginEnabled } from "../../lib/plugins/index.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import {
  activeEngine,
  addonSwitch,
  createMemoryPage,
  createMemoryTestAddon,
  createMemoryTestDeferred,
  createMemoryTestEngine,
  selectEngine,
  toggleAddon,
} from "./memory-page.test-support.ts";
import "./memory-page.ts";

vi.mock("../../lib/plugins/index.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/plugins/index.ts")>();
  return { ...actual, setPluginEnabled: vi.fn() };
});

describe("Memory plugin mutation ownership", () => {
  beforeEach(() => vi.mocked(setPluginEnabled).mockReset());

  it("keeps a committed engine successful while making its failed refresh visible", async () => {
    const { element, runExternalMutation } = createMemoryPage({
      configObject: {},
      catalog: [
        createMemoryTestEngine("memory-core", true),
        createMemoryTestEngine("other", false),
      ],
      refresh: () => Promise.reject(new Error("authoritative snapshot unavailable")),
    });
    document.body.append(element);
    try {
      await waitForFast(() => expect(activeEngine(element)).toBe("memory-core"));
      selectEngine(element, "other");

      await waitForFast(() => expect(runExternalMutation).toHaveBeenCalledOnce());
      await waitForFast(() =>
        expect(element.textContent).toContain(
          "Could not refresh Control UI configuration: authoritative snapshot unavailable",
        ),
      );
      expect(element.textContent).toContain("Needs attention");
      expect(element.textContent).not.toContain("Could not change the memory engine");
    } finally {
      element.remove();
    }
  });

  it("serializes sibling add-on writes through the shared configuration owner", async () => {
    const firstMutation = createMemoryTestDeferred<unknown>();
    const setEnabled = vi.fn((pluginId: string) =>
      pluginId === "active-memory" ? firstMutation.promise : Promise.resolve({}),
    );
    const { element, runExternalMutation } = createMemoryPage({
      configObject: {},
      catalog: [
        createMemoryTestAddon("active-memory", true),
        createMemoryTestAddon("memory-wiki", false),
      ],
      setEnabled,
    });
    document.body.append(element);
    try {
      await waitForFast(() => expect(addonSwitch(element, "Active memory")).not.toBeNull());
      toggleAddon(element, "Active memory", false);
      toggleAddon(element, "Memory wiki", true);

      await waitForFast(() => expect(runExternalMutation).toHaveBeenCalledTimes(2));
      await waitForFast(() => expect(setEnabled).toHaveBeenCalledOnce());
      expect(setEnabled).toHaveBeenCalledWith("active-memory", false);

      firstMutation.resolve({});
      await waitForFast(() => expect(setEnabled).toHaveBeenCalledWith("memory-wiki", true));
    } finally {
      firstMutation.resolve({});
      await Promise.allSettled(runExternalMutation.mock.results.map(({ value }) => value));
      element.remove();
    }
  });

  it("drops an add-on mutation queued before a same-client reconnect", async () => {
    const pendingWrites = createMemoryTestDeferred<void>();
    const setEnabled = vi.fn(() => Promise.resolve({}));
    const { element, runExternalMutation, setPhase } = createMemoryPage({
      configObject: {},
      catalog: [createMemoryTestAddon("active-memory", true)],
      waitForPendingWrites: () => pendingWrites.promise,
      setEnabled,
    });
    document.body.append(element);
    try {
      await waitForFast(() => expect(addonSwitch(element, "Active memory")).not.toBeNull());
      toggleAddon(element, "Active memory", false);
      await waitForFast(() => expect(runExternalMutation).toHaveBeenCalledOnce());

      setPhase("disconnected");
      setPhase("connected");
      pendingWrites.resolve();
      await runExternalMutation.mock.results[0]?.value;

      expect(setEnabled).not.toHaveBeenCalled();
      expect(element.textContent).not.toContain("Could not update Active memory");
    } finally {
      pendingWrites.resolve();
      await Promise.allSettled(runExternalMutation.mock.results.map(({ value }) => value));
      element.remove();
    }
  });

  it("keeps both sibling warnings when earlier process discovery finishes last", async () => {
    const firstProcess = createMemoryTestDeferred<{ processInstanceId: string }>();
    const { element, runExternalMutation } = createMemoryPage({
      configObject: {},
      catalog: [
        createMemoryTestAddon("active-memory", true),
        createMemoryTestAddon("memory-wiki", false),
      ],
      processInfo: (call) =>
        call === 0 ? firstProcess.promise : Promise.resolve({ processInstanceId: "process-a" }),
      setEnabled: (pluginId, enabled) =>
        Promise.resolve({
          restartRequired: false,
          warnings: [`${pluginId} ${enabled ? "enabled" : "disabled"} with a warning.`],
          plugin: createMemoryTestAddon(pluginId, enabled),
        }),
    });
    document.body.append(element);
    try {
      await waitForFast(() => expect(addonSwitch(element, "Active memory")).not.toBeNull());
      toggleAddon(element, "Active memory", false);
      toggleAddon(element, "Memory wiki", true);

      await waitForFast(() =>
        expect(element.textContent).toContain("memory-wiki enabled with a warning."),
      );
      firstProcess.resolve({ processInstanceId: "process-a" });

      await waitForFast(() => {
        expect(element.textContent).toContain("active-memory disabled with a warning.");
        expect(element.textContent).toContain("memory-wiki enabled with a warning.");
      });
    } finally {
      firstProcess.resolve({ processInstanceId: "process-a" });
      await Promise.allSettled(runExternalMutation.mock.results.map(({ value }) => value));
      element.remove();
    }
  });

  it("samples the queued add-on process only when its own mutation begins", async () => {
    const firstMutation = createMemoryTestDeferred<unknown>();
    const observedProcesses: string[] = [];
    let processInstanceId = "process-before-restart";
    const setEnabled = vi.fn((pluginId: string, enabled: boolean) =>
      pluginId === "active-memory"
        ? firstMutation.promise
        : Promise.resolve({
            restartRequired: false,
            warnings: [`${pluginId} ${enabled ? "enabled" : "disabled"} with a warning.`],
            plugin: createMemoryTestAddon(pluginId, enabled),
          }),
    );
    const { element, runExternalMutation } = createMemoryPage({
      configObject: {},
      catalog: [
        createMemoryTestAddon("active-memory", true),
        createMemoryTestAddon("memory-wiki", false),
      ],
      processInfo: () => {
        observedProcesses.push(processInstanceId);
        return Promise.resolve({ processInstanceId });
      },
      setEnabled,
    });
    document.body.append(element);
    try {
      await waitForFast(() => expect(addonSwitch(element, "Active memory")).not.toBeNull());
      toggleAddon(element, "Active memory", false);
      await waitForFast(() => expect(setEnabled).toHaveBeenCalledOnce());
      toggleAddon(element, "Memory wiki", true);
      await waitForFast(() => expect(runExternalMutation).toHaveBeenCalledTimes(2));

      expect(observedProcesses).toEqual(["process-before-restart"]);
      processInstanceId = "process-after-restart";
      firstMutation.resolve({ restartRequired: false });

      await waitForFast(() =>
        expect(element.textContent).toContain("memory-wiki enabled with a warning."),
      );
      expect(observedProcesses).toContain("process-after-restart");
    } finally {
      firstMutation.resolve({ restartRequired: false });
      await Promise.allSettled(runExternalMutation.mock.results.map(({ value }) => value));
      element.remove();
    }
  });

  it("keeps the replacement add-on busy after an older connection finishes", async () => {
    const firstMutation = createMemoryTestDeferred<unknown>();
    const secondMutation = createMemoryTestDeferred<unknown>();
    let mutationCalls = 0;
    const setEnabled = vi.fn(() =>
      mutationCalls++ === 0 ? firstMutation.promise : secondMutation.promise,
    );
    const { element, request, runExternalMutation, setPhase } = createMemoryPage({
      configObject: {},
      catalog: [createMemoryTestAddon("active-memory", true)],
      setEnabled,
    });
    const owner = element as unknown as {
      addonBusy: Set<string>;
      catalog: { kind: string };
    };
    document.body.append(element);
    try {
      await waitForFast(() => expect(addonSwitch(element, "Active memory")).not.toBeNull());
      toggleAddon(element, "Active memory", false);
      await waitForFast(() => expect(setEnabled).toHaveBeenCalledOnce());

      setPhase("disconnected");
      expect(owner.addonBusy.has("active-memory")).toBe(false);
      setPhase("connected");
      await waitForFast(() =>
        expect(request.mock.calls.filter(([method]) => method === "plugins.list")).toHaveLength(2),
      );
      await waitForFast(async () => {
        await element.updateComplete;
        expect(owner.catalog.kind).toBe("ready");
        expect(addonSwitch(element, "Active memory")).not.toBeNull();
      });
      toggleAddon(element, "Active memory", false);
      await waitForFast(() => expect(runExternalMutation).toHaveBeenCalledTimes(2));

      firstMutation.resolve({});
      await waitForFast(() => expect(setEnabled).toHaveBeenCalledTimes(2));
      await waitForFast(() =>
        expect(request.mock.calls.filter(([method]) => method === "plugins.list")).toHaveLength(3),
      );
      await element.updateComplete;
      expect(owner.addonBusy.has("active-memory")).toBe(true);

      secondMutation.resolve({});
      await waitForFast(() => expect(owner.addonBusy.has("active-memory")).toBe(false));
    } finally {
      firstMutation.resolve({});
      secondMutation.resolve({});
      await Promise.allSettled(runExternalMutation.mock.results.map(({ value }) => value));
      element.remove();
    }
  });

  it("keeps the replacement engine busy after an older connection finishes", async () => {
    const firstMutation = createMemoryTestDeferred<unknown>();
    const secondMutation = createMemoryTestDeferred<unknown>();
    let mutationCalls = 0;
    const setEnabled = vi.fn(() =>
      mutationCalls++ === 0 ? firstMutation.promise : secondMutation.promise,
    );
    const { element, request, runExternalMutation, setPhase } = createMemoryPage({
      configObject: {},
      catalog: [
        createMemoryTestEngine("memory-core", true),
        createMemoryTestEngine("other", false),
      ],
      setEnabled,
    });
    const owner = element as unknown as { engineBusy: boolean; catalog: { kind: string } };
    document.body.append(element);
    try {
      await waitForFast(() => expect(activeEngine(element)).toBe("memory-core"));
      selectEngine(element, "other");
      await waitForFast(() => expect(setEnabled).toHaveBeenCalledOnce());

      setPhase("disconnected");
      expect(owner.engineBusy).toBe(false);
      setPhase("connected");
      await waitForFast(() =>
        expect(request.mock.calls.filter(([method]) => method === "plugins.list")).toHaveLength(2),
      );
      await waitForFast(async () => {
        await element.updateComplete;
        expect(owner.catalog.kind).toBe("ready");
        expect(activeEngine(element)).toBe("memory-core");
      });
      selectEngine(element, "other");
      await waitForFast(() => expect(runExternalMutation).toHaveBeenCalledTimes(2));

      firstMutation.resolve({});
      await waitForFast(() => expect(setEnabled).toHaveBeenCalledTimes(2));
      await waitForFast(() =>
        expect(request.mock.calls.filter(([method]) => method === "plugins.list")).toHaveLength(3),
      );
      await element.updateComplete;
      expect(owner.engineBusy).toBe(true);

      secondMutation.resolve({});
      await waitForFast(() => expect(owner.engineBusy).toBe(false));
    } finally {
      firstMutation.resolve({});
      secondMutation.resolve({});
      await Promise.allSettled(runExternalMutation.mock.results.map(({ value }) => value));
      element.remove();
    }
  });

  it("keeps a newer add-on notice when an older process lookup finishes last", async () => {
    const firstProcess = createMemoryTestDeferred<{ processInstanceId: string }>();
    let enabled = true;
    const { element, request, runExternalMutation, setPhase } = createMemoryPage({
      configObject: {},
      listCatalog: () =>
        Promise.resolve({ plugins: [createMemoryTestAddon("active-memory", enabled)] }),
      processInfo: (call) =>
        call === 0
          ? firstProcess.promise
          : Promise.resolve({ processInstanceId: "process-current" }),
      setEnabled: (pluginId, nextEnabled) => {
        enabled = nextEnabled;
        return Promise.resolve({
          restartRequired: false,
          warnings: [`${pluginId} ${nextEnabled ? "enabled" : "disabled"} with a warning.`],
          plugin: createMemoryTestAddon(pluginId, nextEnabled),
        });
      },
    });
    document.body.append(element);
    try {
      await waitForFast(() => expect(addonSwitch(element, "Active memory")?.checked).toBe(true));
      toggleAddon(element, "Active memory", false);
      await waitForFast(() => expect(runExternalMutation).toHaveBeenCalledOnce());
      await runExternalMutation.mock.results[0]?.value;

      setPhase("disconnected");
      setPhase("connected");
      await waitForFast(() => expect(addonSwitch(element, "Active memory")?.checked).toBe(false));
      toggleAddon(element, "Active memory", true);

      const currentNotice = "active-memory enabled with a warning.";
      await waitForFast(() => expect(element.textContent).toContain(currentNotice));
      firstProcess.resolve({ processInstanceId: "process-current" });
      await waitForFast(() =>
        expect(request.mock.calls.filter(([method]) => method === "plugins.list")).toHaveLength(4),
      );
      await element.updateComplete;

      expect(element.textContent).toContain(currentNotice);
      expect(element.textContent).not.toContain("active-memory disabled with a warning.");
    } finally {
      firstProcess.resolve({ processInstanceId: "process-current" });
      await Promise.allSettled(runExternalMutation.mock.results.map(({ value }) => value));
      element.remove();
    }
  });

  it("drops an obsolete refresh warning while preserving a committed plugin warning", async () => {
    const firstProcess = createMemoryTestDeferred<{ processInstanceId: string }>();
    let failRefresh = true;
    let enabled = true;
    const { element, request, runExternalMutation, setPhase } = createMemoryPage({
      configObject: {},
      listCatalog: () =>
        Promise.resolve({ plugins: [createMemoryTestAddon("active-memory", enabled)] }),
      processInfo: (call) =>
        call === 0
          ? firstProcess.promise
          : Promise.resolve({ processInstanceId: "process-current" }),
      refresh: () =>
        failRefresh
          ? Promise.reject(new Error("old authoritative refresh failed"))
          : Promise.resolve(),
      setEnabled: (pluginId, nextEnabled) => {
        enabled = nextEnabled;
        return Promise.resolve({
          restartRequired: false,
          warnings: [`${pluginId} ${nextEnabled ? "enabled" : "disabled"} with a warning.`],
          plugin: createMemoryTestAddon(pluginId, nextEnabled),
        });
      },
    });
    document.body.append(element);
    try {
      await waitForFast(() => expect(addonSwitch(element, "Active memory")?.checked).toBe(true));
      toggleAddon(element, "Active memory", false);
      await waitForFast(() => expect(runExternalMutation).toHaveBeenCalledOnce());
      await runExternalMutation.mock.results[0]?.value;

      failRefresh = false;
      setPhase("disconnected");
      setPhase("connected");
      await waitForFast(() => expect(addonSwitch(element, "Active memory")?.checked).toBe(false));
      firstProcess.resolve({ processInstanceId: "process-current" });
      await waitForFast(() =>
        expect(request.mock.calls.filter(([method]) => method === "plugins.list")).toHaveLength(3),
      );
      await element.updateComplete;

      expect(element.textContent).toContain("active-memory disabled with a warning.");
      expect(element.textContent).not.toContain("old authoritative refresh failed");
      expect(element.textContent).not.toContain("Could not refresh Control UI configuration");
    } finally {
      firstProcess.resolve({ processInstanceId: "process-current" });
      await Promise.allSettled(runExternalMutation.mock.results.map(({ value }) => value));
      element.remove();
    }
  });

  it("clears a rendered refresh warning after reconnect without losing its plugin warning", async () => {
    let failRefresh = true;
    let enabled = true;
    const { element, runExternalMutation, setPhase } = createMemoryPage({
      configObject: {},
      listCatalog: () =>
        Promise.resolve({ plugins: [createMemoryTestAddon("active-memory", enabled)] }),
      processInfo: () => Promise.resolve({ processInstanceId: "same-process" }),
      refresh: () =>
        failRefresh
          ? Promise.reject(new Error("old authoritative refresh failed"))
          : Promise.resolve(),
      setEnabled: (pluginId, nextEnabled) => {
        enabled = nextEnabled;
        return Promise.resolve({
          restartRequired: false,
          warnings: [`${pluginId} ${nextEnabled ? "enabled" : "disabled"} with a warning.`],
          plugin: createMemoryTestAddon(pluginId, nextEnabled),
        });
      },
    });
    document.body.append(element);
    try {
      await waitForFast(() => expect(addonSwitch(element, "Active memory")?.checked).toBe(true));
      toggleAddon(element, "Active memory", false);
      await waitForFast(() => {
        expect(element.textContent).toContain("old authoritative refresh failed");
        expect(element.textContent).toContain("active-memory disabled with a warning.");
      });

      failRefresh = false;
      setPhase("disconnected");
      setPhase("connected");
      await waitForFast(() => {
        expect(element.textContent).not.toContain("old authoritative refresh failed");
        expect(element.textContent).toContain("active-memory disabled with a warning.");
      });
    } finally {
      await Promise.allSettled(runExternalMutation.mock.results.map(({ value }) => value));
      element.remove();
    }
  });

  it.each([
    ["active-memory", "memory-wiki"],
    ["engine", "active-memory"],
    ["active-memory", "engine"],
  ] as const)(
    "clears a %s refresh warning when %s refreshes authoritative configuration",
    async (first, second) => {
      let refreshCalls = 0;
      const { element, runExternalMutation } = createMemoryPage({
        configObject: {},
        catalog: [
          createMemoryTestEngine("memory-core", true),
          createMemoryTestEngine("other", false),
          createMemoryTestAddon("active-memory", true),
          createMemoryTestAddon("memory-wiki", false),
        ],
        processInfo: () => Promise.resolve({ processInstanceId: "same-process" }),
        refresh: () =>
          refreshCalls++ === 0
            ? Promise.reject(new Error("previous authoritative refresh failed"))
            : Promise.resolve(),
        setEnabled: (pluginId, enabled) =>
          Promise.resolve(
            pluginId === "active-memory"
              ? {
                  restartRequired: false,
                  plugin: createMemoryTestAddon(pluginId, enabled),
                  warnings: [`${pluginId} ${enabled ? "enabled" : "disabled"} with a warning.`],
                }
              : {},
          ),
      });
      document.body.append(element);
      const mutate = (owner: typeof first | typeof second) => {
        if (owner === "engine") {
          selectEngine(element, "other");
          return;
        }
        toggleAddon(
          element,
          owner === "active-memory" ? "Active memory" : "Memory wiki",
          owner === "memory-wiki",
        );
      };
      try {
        await waitForFast(() => expect(activeEngine(element)).toBe("memory-core"));
        await waitForFast(() => expect(addonSwitch(element, "Active memory")).not.toBeNull());
        mutate(first);
        await waitForFast(() =>
          expect(element.textContent).toContain("previous authoritative refresh failed"),
        );

        mutate(second);
        await waitForFast(() => expect(runExternalMutation).toHaveBeenCalledTimes(2));
        await waitForFast(() =>
          expect(element.textContent).not.toContain("previous authoritative refresh failed"),
        );
        if (first === "active-memory") {
          expect(element.textContent).toContain("active-memory disabled with a warning.");
        }
      } finally {
        await Promise.allSettled(runExternalMutation.mock.results.map(({ value }) => value));
        element.remove();
      }
    },
  );

  it("reloads the replacement connection after an older engine change commits", async () => {
    const pendingMutation = createMemoryTestDeferred<unknown>();
    const { element, request, runExternalMutation, setPhase } = createMemoryPage({
      configObject: {},
      listCatalog: (call) =>
        Promise.resolve({
          plugins:
            call < 2
              ? [
                  createMemoryTestEngine("memory-core", true),
                  createMemoryTestEngine("other", false),
                ]
              : [
                  createMemoryTestEngine("memory-core", false),
                  createMemoryTestEngine("other", true),
                ],
        }),
      setEnabled: () => pendingMutation.promise,
    });
    document.body.append(element);
    try {
      await waitForFast(() => expect(activeEngine(element)).toBe("memory-core"));
      selectEngine(element, "other");
      await waitForFast(() => expect(setPluginEnabled).toHaveBeenCalledOnce());

      setPhase("disconnected");
      setPhase("connected");
      await waitForFast(() =>
        expect(request.mock.calls.filter(([method]) => method === "plugins.list")).toHaveLength(2),
      );
      pendingMutation.resolve({});

      await waitForFast(() =>
        expect(request.mock.calls.filter(([method]) => method === "plugins.list")).toHaveLength(3),
      );
      expect(element.textContent).not.toContain("Could not change the memory engine");
    } finally {
      pendingMutation.resolve({});
      await Promise.allSettled(runExternalMutation.mock.results.map(({ value }) => value));
      element.remove();
    }
  });
});
