import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { describe, expect, it, vi } from "vitest";
import { createActiveCfgProvider, resolveActiveCfg, type GatewayCfgLoader } from "./active-cfg.js";

const getRuntimeConfigMock = vi.hoisted(() => vi.fn<() => OpenClawConfig>());

vi.mock("openclaw/plugin-sdk/runtime-config-snapshot", () => ({
  getRuntimeConfig: getRuntimeConfigMock,
}));

function asCfg(shape: { bindings: Array<{ id: string }> }): OpenClawConfig {
  return shape as unknown as OpenClawConfig;
}

describe("resolveActiveCfg", () => {
  it("returns the freshly loaded value when the loader succeeds", () => {
    const fresh = asCfg({ bindings: [{ id: "fresh" }] });
    const fallback = asCfg({ bindings: [{ id: "stale" }] });
    const loader: GatewayCfgLoader = () => fresh;

    expect(resolveActiveCfg(loader, fallback)).toBe(fresh);
  });

  it("falls back when the loader throws", () => {
    const fallback = asCfg({ bindings: [{ id: "stale" }] });
    const loader: GatewayCfgLoader = () => {
      throw new Error("snapshot not initialised");
    };

    expect(resolveActiveCfg(loader, fallback)).toBe(fallback);
  });
});

describe("createActiveCfgProvider", () => {
  it("invokes the injected loader on every getActiveCfg call", () => {
    const fallback = asCfg({ bindings: [] });
    const first = asCfg({ bindings: [{ id: "first" }] });
    const second = asCfg({ bindings: [{ id: "second" }] });
    const load = vi
      .fn<() => OpenClawConfig>()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second);

    const provider = createActiveCfgProvider({ fallback, load });

    expect(provider.getActiveCfg()).toBe(first);
    expect(provider.getActiveCfg()).toBe(second);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("never caches a previously loaded value", () => {
    const fallback = asCfg({ bindings: [] });
    const calls: OpenClawConfig[] = [
      asCfg({ bindings: [{ id: "a" }] }),
      asCfg({ bindings: [{ id: "b" }] }),
      asCfg({ bindings: [{ id: "c" }] }),
    ];
    let index = 0;
    const provider = createActiveCfgProvider({
      fallback,
      load: () => calls[index++],
    });

    expect(provider.getActiveCfg()).toBe(calls[0]);
    expect(provider.getActiveCfg()).toBe(calls[1]);
    expect(provider.getActiveCfg()).toBe(calls[2]);
  });

  it("delegates to getRuntimeConfig when no loader is provided", () => {
    const live = asCfg({ bindings: [{ id: "live" }] });
    getRuntimeConfigMock.mockReset();
    getRuntimeConfigMock.mockReturnValue(live);

    const provider = createActiveCfgProvider({ fallback: asCfg({ bindings: [] }) });

    expect(provider.getActiveCfg()).toBe(live);
    expect(getRuntimeConfigMock).toHaveBeenCalledTimes(1);
  });

  it("falls back to the supplied snapshot when the SDK getter throws", () => {
    const fallback = asCfg({ bindings: [{ id: "snapshot" }] });
    getRuntimeConfigMock.mockReset();
    getRuntimeConfigMock.mockImplementation(() => {
      throw new Error("not ready");
    });

    const provider = createActiveCfgProvider({ fallback });

    expect(provider.getActiveCfg()).toBe(fallback);
  });
});
