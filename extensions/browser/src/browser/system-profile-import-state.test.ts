import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { describe, expect, it } from "vitest";
import {
  configureSystemProfileImportStateStore,
  dismissSystemProfileImportPrompt,
  readSystemProfileImportState,
  recordSystemProfileImport,
  resolveSuggestedImportTarget,
  type SystemProfileImportState,
} from "./system-profile-import-state.js";

function createMemoryStore(): PluginStateKeyedStore<SystemProfileImportState> {
  const values = new Map<string, SystemProfileImportState>();
  return {
    register: async (key, value) => {
      values.set(key, value);
    },
    registerIfAbsent: async (key, value) => {
      if (values.has(key)) {
        return false;
      }
      values.set(key, value);
      return true;
    },
    lookup: async (key) => values.get(key),
    consume: async (key) => {
      const value = values.get(key);
      values.delete(key);
      return value;
    },
    delete: async (key) => values.delete(key),
    entries: async () => [],
    clear: async () => values.clear(),
  };
}

describe("system profile import state", () => {
  it("persists dismiss and successful import outcomes", async () => {
    configureSystemProfileImportStateStore(createMemoryStore());

    await dismissSystemProfileImportPrompt(10);
    expect(await readSystemProfileImportState()).toEqual({
      version: 1,
      status: "dismissed",
      updatedAt: 10,
    });

    await recordSystemProfileImport(
      { browser: "chrome", systemProfile: "Default", targetProfile: "imported" },
      20,
    );
    expect(await readSystemProfileImportState()).toEqual({
      version: 1,
      status: "imported",
      browser: "chrome",
      systemProfile: "Default",
      targetProfile: "imported",
      updatedAt: 20,
    });
  });

  it("reuses only the recorded target and otherwise avoids collisions", () => {
    expect(resolveSuggestedImportTarget({ profileNames: ["openclaw"] })).toBe("imported");
    expect(resolveSuggestedImportTarget({ profileNames: ["openclaw", "imported"] })).toBe(
      "imported-2",
    );
    expect(
      resolveSuggestedImportTarget({
        profileNames: ["openclaw", "imported", "imported-2"],
        state: {
          version: 1,
          status: "imported",
          browser: "chrome",
          systemProfile: "Default",
          targetProfile: "imported-2",
          updatedAt: 20,
        },
      }),
    ).toBe("imported-2");
  });
});
