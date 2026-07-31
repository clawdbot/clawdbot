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
} from "./memory-page.test.support.ts";
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
      expect(setEnabled).toHaveBeenCalledTimes(1);
      expect(setEnabled).toHaveBeenCalledWith("active-memory", false);

      firstMutation.resolve({});
      await waitForFast(() => expect(setEnabled).toHaveBeenCalledWith("memory-wiki", true));
    } finally {
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
      element.remove();
    }
  });

  it("reloads the replacement connection after an older engine change commits", async () => {
    const pendingMutation = createMemoryTestDeferred<unknown>();
    const { element, request, setPhase } = createMemoryPage({
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
      element.remove();
    }
  });
});
