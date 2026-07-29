import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConfigFileSnapshot, OpenClawConfig } from "../config/types.openclaw.js";

const mocks = vi.hoisted(() => ({
  appliedConfigHash: "applied-1" as string | null,
  configPath: "",
  pluginRegistryVersion: 1,
  readConfigFileSnapshot: vi.fn<() => Promise<ConfigFileSnapshot>>(),
}));

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    createConfigIO: () => ({ configPath: mocks.configPath }),
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

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-config-get-cache-"));

function configSnapshot(sourceConfig: OpenClawConfig): ConfigFileSnapshot {
  return {
    path: mocks.configPath,
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

beforeEach(async () => {
  invalidateConfigGetResponseCache();
  mocks.appliedConfigHash = "applied-1";
  mocks.pluginRegistryVersion = 1;
  mocks.configPath = path.join(tempRoot, "openclaw.json");
  await fs.writeFile(mocks.configPath, '{"gateway":{"port":19001}}\n');
  mocks.readConfigFileSnapshot.mockReset();
  mocks.readConfigFileSnapshot.mockResolvedValue(configSnapshot({ gateway: { port: 19_001 } }));
});

afterAll(async () => {
  await fs.rm(tempRoot, { recursive: true, force: true });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("config.get response cache", () => {
  it("shares a stable response across concurrent and settled callers", async () => {
    const loadUiHints = vi.fn(() => undefined);

    const concurrent = await Promise.all(
      Array.from({ length: 8 }, () => readConfigGetResponse({ loadUiHints })),
    );
    const settled = await readConfigGetResponse({ loadUiHints });

    expect(mocks.readConfigFileSnapshot).toHaveBeenCalledTimes(1);
    expect(loadUiHints).toHaveBeenCalledTimes(1);
    expect(concurrent.every((response) => response === concurrent[0])).toBe(true);
    expect(settled).toBe(concurrent[0]);
  });

  it("rebuilds for file stamps, applied config revisions, and plugin schema generations", async () => {
    const loadUiHints = vi.fn(() => undefined);
    await readConfigGetResponse({ loadUiHints });

    await fs.writeFile(mocks.configPath, '{"gateway":{"port":190012}}\n');
    await readConfigGetResponse({ loadUiHints });

    mocks.appliedConfigHash = "applied-2";
    await readConfigGetResponse({ loadUiHints });

    mocks.pluginRegistryVersion = 2;
    await readConfigGetResponse({ loadUiHints });

    expect(mocks.readConfigFileSnapshot).toHaveBeenCalledTimes(4);
    expect(loadUiHints).toHaveBeenCalledTimes(4);
  });

  it("rebuilds immediately after explicit write-path invalidation", async () => {
    const loadUiHints = vi.fn(() => undefined);
    await readConfigGetResponse({ loadUiHints });

    invalidateConfigGetResponseCache();
    await readConfigGetResponse({ loadUiHints });

    expect(mocks.readConfigFileSnapshot).toHaveBeenCalledTimes(2);
  });

  it("revalidates an unchanged file stamp after the bounded cache window", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const loadUiHints = vi.fn(() => undefined);
    await readConfigGetResponse({ loadUiHints });

    now.mockReturnValue(6_001);
    await readConfigGetResponse({ loadUiHints });

    expect(mocks.readConfigFileSnapshot).toHaveBeenCalledTimes(2);
  });
});
