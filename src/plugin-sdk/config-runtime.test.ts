import { describe, expect, it } from "vitest";
import {
  resolveLivePluginConfigObject,
  resolvePluginConfigObject,
  type OpenClawConfig,
} from "./config-runtime.js";

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
