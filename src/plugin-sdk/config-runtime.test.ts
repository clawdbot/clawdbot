/**
 * Tests config runtime exports and snapshot/cache behavior exposed through the SDK.
 */
import { describe, expect, it } from "vitest";
import {
  getSessionEntry,
  listSessionEntries,
  readSessionUpdatedAt,
  resolveLivePluginConfigObject,
  resolvePluginConfigObject,
  type OpenClawConfig,
} from "./config-runtime.js";
import {
  getSessionEntry as getSessionStoreEntry,
  listSessionEntries as listSessionStoreEntries,
  readSessionUpdatedAt as readSessionStoreUpdatedAt,
} from "./session-store-runtime.js";

describe("config-runtime session read exports", () => {
  it("re-exports the session-store runtime seam wrappers", () => {
    expect(getSessionEntry).toBe(getSessionStoreEntry);
    expect(listSessionEntries).toBe(listSessionStoreEntries);
    expect(readSessionUpdatedAt).toBe(readSessionStoreUpdatedAt);
  });
});

describe("resolvePluginConfigObject", () => {
  it("returns the plugin config object for a configured plugin entry", () => {
    const config = {
      plugins: {
        entries: {
          "demo-plugin": {
            enabled: true,
            config: {
              enabled: false,
              mode: "strict",
            },
          },
        },
      },
    } as unknown as OpenClawConfig;

    expect(resolvePluginConfigObject(config, "demo-plugin")).toEqual({
      enabled: false,
      mode: "strict",
    });
  });

  it("reads config through normalized plugin entry ids", () => {
    const config = {
      plugins: {
        entries: {
          " CODEX ": {
            enabled: true,
            config: { supervision: { enabled: true } },
          },
        },
      },
    } as unknown as OpenClawConfig;

    expect(resolvePluginConfigObject(config, "codex")).toEqual({
      supervision: { enabled: true },
    });
  });

  it("returns undefined for missing or non-object plugin configs", () => {
    const config = {
      plugins: {
        entries: {
          "demo-plugin": {
            enabled: true,
            config: "bad-shape",
          },
          "array-plugin": {
            enabled: true,
            config: ["bad-shape"],
          },
        },
      },
    } as unknown as OpenClawConfig;

    expect(resolvePluginConfigObject(config, "missing-plugin")).toBeUndefined();
    expect(resolvePluginConfigObject(config, "demo-plugin")).toBeUndefined();
    expect(resolvePluginConfigObject(config, "array-plugin")).toBeUndefined();
    expect(resolvePluginConfigObject(undefined, "demo-plugin")).toBeUndefined();
  });
});

describe("resolveLivePluginConfigObject", () => {
  it("falls back to startup config only when no runtime loader exists", () => {
    expect(
      resolveLivePluginConfigObject(undefined, "demo-plugin", {
        enabled: true,
      }),
    ).toEqual({
      enabled: true,
    });
  });

  it("fails closed when the runtime loader exists but the plugin entry is missing", () => {
    const config = {
      plugins: {
        entries: {},
      },
    } as unknown as OpenClawConfig;

    expect(
      resolveLivePluginConfigObject(() => config, "demo-plugin", {
        enabled: true,
      }),
    ).toBeUndefined();
  });
});
