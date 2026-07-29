import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConfigFileSnapshot, OpenClawConfig } from "../config/types.openclaw.js";

const mocks = vi.hoisted(() => ({
  appliedConfigHash: "applied-1" as string | null,
  pluginRegistryVersion: 1,
  readConfigFileSnapshot: vi.fn<() => Promise<ConfigFileSnapshot>>(),
}));

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    readConfigFileSnapshot: mocks.readConfigFileSnapshot,
  };
});

vi.mock("../config/runtime-snapshot.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/runtime-snapshot.js")>();
  return {
    ...actual,
    getRuntimeConfigAppliedHash: () => mocks.appliedConfigHash,
  };
});

vi.mock("../plugins/runtime.js", () => ({
  getActivePluginRegistryVersion: () => mocks.pluginRegistryVersion,
}));

const { invalidateConfigGetResponseCache, readConfigGetResponse } =
  await import("./config-get-response.js");

const activeWatcher = () => "active" as const;
const disabledWatcher = () => "disabled" as const;

function configSnapshot(sourceConfig: OpenClawConfig): ConfigFileSnapshot {
  return {
    path: "/tmp/openclaw.json",
    exists: true,
    raw: JSON.stringify(sourceConfig),
    parsed: sourceConfig,
    sourceConfig,
    resolved: sourceConfig,
    valid: true,
    runtimeConfig: sourceConfig,
    config: sourceConfig,
    issues: [],
    warnings: [],
    legacyIssues: [],
  } as ConfigFileSnapshot;
}

beforeEach(() => {
  invalidateConfigGetResponseCache();
  mocks.appliedConfigHash = "applied-1";
  mocks.pluginRegistryVersion = 1;
  mocks.readConfigFileSnapshot.mockReset();
  mocks.readConfigFileSnapshot.mockResolvedValue(configSnapshot({ gateway: { port: 19_001 } }));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("config.get response cache", () => {
  it("serves identical bytes without filesystem work on an active-watcher cache hit", async () => {
    const loadUiHints = vi.fn(() => undefined);
    const first = await readConfigGetResponse({ getHotReloadStatus: activeWatcher, loadUiHints });
    const stat = vi.spyOn(fs.promises, "stat");
    mocks.readConfigFileSnapshot.mockClear();
    loadUiHints.mockClear();

    const hit = await readConfigGetResponse({ getHotReloadStatus: activeWatcher, loadUiHints });

    expect(hit).toBe(first);
    expect(stat).not.toHaveBeenCalled();
    expect(mocks.readConfigFileSnapshot).not.toHaveBeenCalled();
    expect(loadUiHints).not.toHaveBeenCalled();

    invalidateConfigGetResponseCache();
    const fresh = await readConfigGetResponse({ getHotReloadStatus: activeWatcher, loadUiHints });
    expect(hit).toEqual(fresh);
  });

  it("shares one projection across concurrent active-watcher callers", async () => {
    const loadUiHints = vi.fn(() => undefined);

    const responses = await Promise.all(
      Array.from({ length: 8 }, () =>
        readConfigGetResponse({ getHotReloadStatus: activeWatcher, loadUiHints }),
      ),
    );

    expect(mocks.readConfigFileSnapshot).toHaveBeenCalledOnce();
    expect(loadUiHints).toHaveBeenCalledOnce();
    expect(responses.every((response) => response === responses[0])).toBe(true);
  });

  it("evicts a failed projection instead of retaining its rejected promise", async () => {
    const loadUiHints = vi.fn(() => undefined);
    mocks.readConfigFileSnapshot.mockRejectedValueOnce(new Error("transient read failure"));

    await expect(
      readConfigGetResponse({ getHotReloadStatus: activeWatcher, loadUiHints }),
    ).rejects.toThrow("transient read failure");
    await expect(
      readConfigGetResponse({ getHotReloadStatus: activeWatcher, loadUiHints }),
    ).resolves.toMatchObject({ appliedConfigHash: "applied-1" });

    expect(mocks.readConfigFileSnapshot).toHaveBeenCalledTimes(2);
  });

  it("rebuilds when the active plugin metadata generation changes", async () => {
    const loadUiHints = vi.fn(() => undefined);
    await readConfigGetResponse({ getHotReloadStatus: activeWatcher, loadUiHints });

    mocks.pluginRegistryVersion = 2;
    await readConfigGetResponse({ getHotReloadStatus: activeWatcher, loadUiHints });

    expect(mocks.readConfigFileSnapshot).toHaveBeenCalledTimes(2);
    expect(loadUiHints).toHaveBeenCalledTimes(2);
  });

  it("rebuilds immediately after watcher or write-path invalidation", async () => {
    const loadUiHints = vi.fn(() => undefined);
    await readConfigGetResponse({ getHotReloadStatus: activeWatcher, loadUiHints });

    invalidateConfigGetResponseCache();
    await readConfigGetResponse({ getHotReloadStatus: activeWatcher, loadUiHints });

    expect(mocks.readConfigFileSnapshot).toHaveBeenCalledTimes(2);
  });

  it("bypasses the cache when hot reload is disabled", async () => {
    const loadUiHints = vi.fn(() => undefined);

    await readConfigGetResponse({ getHotReloadStatus: disabledWatcher, loadUiHints });
    await readConfigGetResponse({ getHotReloadStatus: disabledWatcher, loadUiHints });

    expect(mocks.readConfigFileSnapshot).toHaveBeenCalledTimes(2);
    expect(loadUiHints).toHaveBeenCalledTimes(2);
  });

  it("bypasses the cache when no config watcher status is available", async () => {
    const loadUiHints = vi.fn(() => undefined);

    await readConfigGetResponse({ loadUiHints });
    await readConfigGetResponse({ loadUiHints });

    expect(mocks.readConfigFileSnapshot).toHaveBeenCalledTimes(2);
    expect(loadUiHints).toHaveBeenCalledTimes(2);
  });
});
