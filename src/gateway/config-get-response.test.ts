import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConfigFileSnapshot, OpenClawConfig } from "../config/types.openclaw.js";

const mocks = vi.hoisted(() => ({
  appliedConfigHash: "applied-1" as string | null,
  configSnapshotMetadata: {
    revision: 1,
    fingerprint: "runtime-1",
    sourceFingerprint: "source-1",
    updatedAtMs: 0,
  } as {
    revision: number;
    fingerprint: string;
    sourceFingerprint: string | null;
    updatedAtMs: number;
  } | null,
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
    getRuntimeConfigSnapshotMetadata: () => mocks.configSnapshotMetadata,
  };
});

vi.mock("../plugins/runtime.js", () => ({
  getActivePluginRegistryVersion: () => mocks.pluginRegistryVersion,
}));

const { invalidateConfigGetResponseCache, readConfigGetResponse: readConfigGetResponseImpl } =
  await import("./config-get-response.js");

const revisionProjector = {
  projectRawHash: (hash: string) => `raw-token:${hash}`,
  projectResolvedHash: (hash: string) => `resolved-token:${hash}`,
};

function readConfigGetResponse(
  params: Omit<Parameters<typeof readConfigGetResponseImpl>[0], "revisionProjector">,
) {
  return readConfigGetResponseImpl({ ...params, revisionProjector });
}

const activeWatcher = () => "active" as const;
const disabledWatcher = () => "disabled" as const;

function configSnapshot(sourceConfig: OpenClawConfig): ConfigFileSnapshot {
  return {
    path: "/tmp/openclaw.json",
    exists: true,
    raw: JSON.stringify(sourceConfig),
    hash: "raw-1",
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
  mocks.configSnapshotMetadata = {
    revision: 1,
    fingerprint: "runtime-1",
    sourceFingerprint: "source-1",
    updatedAtMs: 0,
  };
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
    ).resolves.toMatchObject({ appliedConfigHash: "resolved-token:applied-1" });

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

  // An authored edit whose effective diff is empty is committed as a source-only publication:
  // `notifyCommitted` (config-reload.ts) skips its invalidation because no path changed, the
  // applied hash moves only when a candidate is runtime-applied, and the registry version holds
  // still too. The republish keeps the runtime object — and so its fingerprint — while the source
  // fingerprint tracks the new canonical source content, so that is the half a hit must prove or
  // config.get keeps serving the pre-edit authored snapshot.
  it("rebuilds after a source-only republish that leaves the applied hash unchanged", async () => {
    const loadUiHints = vi.fn(() => undefined);
    await readConfigGetResponse({ getHotReloadStatus: activeWatcher, loadUiHints });

    mocks.configSnapshotMetadata = {
      revision: 2,
      fingerprint: "runtime-1",
      sourceFingerprint: "source-2",
      updatedAtMs: 0,
    };
    await readConfigGetResponse({ getHotReloadStatus: activeWatcher, loadUiHints });

    expect(mocks.readConfigFileSnapshot).toHaveBeenCalledTimes(2);
  });

  // `resetConfigRuntimeState` zeroes the snapshot revision counter without invalidating this
  // cache (`clearSecretsRuntimeSnapshotState` reaches it on the managed-secrets failure paths),
  // so a later publication can present a previously seen revision number for different content.
  // The fingerprint key must miss where the revision key false-hit.
  it("rebuilds when a cleared runtime republishes different content at a recycled revision", async () => {
    const loadUiHints = vi.fn(() => undefined);
    await readConfigGetResponse({ getHotReloadStatus: activeWatcher, loadUiHints });

    mocks.configSnapshotMetadata = {
      revision: 1,
      fingerprint: "runtime-2",
      sourceFingerprint: "source-2",
      updatedAtMs: 0,
    };
    await readConfigGetResponse({ getHotReloadStatus: activeWatcher, loadUiHints });

    expect(mocks.readConfigFileSnapshot).toHaveBeenCalledTimes(2);
  });

  // While snapshot state is cleared there is no source fingerprint to prove, so nothing built in
  // that window may be served from cache — the cleared window is exactly when a stale channel
  // claimant answer would otherwise survive.
  it("bypasses the cache while runtime snapshot state is cleared", async () => {
    const loadUiHints = vi.fn(() => undefined);
    await readConfigGetResponse({ getHotReloadStatus: activeWatcher, loadUiHints });

    mocks.configSnapshotMetadata = null;
    await readConfigGetResponse({ getHotReloadStatus: activeWatcher, loadUiHints });
    await readConfigGetResponse({ getHotReloadStatus: activeWatcher, loadUiHints });

    expect(mocks.readConfigFileSnapshot).toHaveBeenCalledTimes(3);
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

// Codex review P1 on #123209: the schema this redacts with is chosen by the config, since the
// config decides which plugin owns a channel. Handing the loader nothing let it answer from a
// cache keyed on plugin registry version alone, which a `channels.<id>` hot reload never changes.
describe("config.get redaction hint source", () => {
  it("builds hints from the config it is about to redact", async () => {
    const seen: unknown[] = [];
    await readConfigGetResponse({
      getHotReloadStatus: disabledWatcher,
      loadUiHints: (config) => {
        seen.push(config);
        return undefined;
      },
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]).toBeDefined();
  });
});
