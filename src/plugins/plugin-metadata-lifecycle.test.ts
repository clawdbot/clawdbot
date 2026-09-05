import { expect, it, vi } from "vitest";
import {
  getCurrentPluginMetadataSnapshotState,
  setCurrentPluginMetadataSnapshotState,
} from "./current-plugin-metadata-state.js";
import { getPluginCache } from "./plugin-cache.js";
import {
  clearPluginMetadataLifecycleCaches,
  registerPluginMetadataProcessMemoLifecycleClear,
  retainGatewayPluginMetadata,
} from "./plugin-metadata-lifecycle.js";

const clearMemo = vi.fn();
registerPluginMetadataProcessMemoLifecycleClear(clearMemo);

it("keeps boot metadata and process memos until the final Gateway releases them", () => {
  const firstAccessCache = getPluginCache();
  const releaseFirst = retainGatewayPluginMetadata();
  const releaseSecond = retainGatewayPluginMetadata();
  try {
    const snapshot = { plugins: [] };
    setCurrentPluginMetadataSnapshotState(
      snapshot,
      "boot",
      undefined,
      undefined,
      undefined,
      "gateway",
    );
    clearMemo.mockClear();

    clearPluginMetadataLifecycleCaches();
    expect(releaseSecond()).toBe(false);
    expect(releaseSecond()).toBe(false);

    expect(getCurrentPluginMetadataSnapshotState().snapshot).toBe(snapshot);
    expect(clearMemo).not.toHaveBeenCalled();
    expect(getPluginCache()).toBe(firstAccessCache);

    expect(releaseFirst()).toBe(true);
    expect(getCurrentPluginMetadataSnapshotState().snapshot).toBeUndefined();
    expect(clearMemo).toHaveBeenCalledOnce();
    expect(getPluginCache()).not.toBe(firstAccessCache);
    expect(releaseFirst()).toBe(false);
    expect(clearMemo).toHaveBeenCalledOnce();
  } finally {
    releaseSecond();
    releaseFirst();
  }
});

it("allows startup planning metadata to refresh before a Gateway inventory is published", () => {
  const release = retainGatewayPluginMetadata();
  try {
    setCurrentPluginMetadataSnapshotState({ plugins: [] }, "planning");
    clearPluginMetadataLifecycleCaches();
    expect(getCurrentPluginMetadataSnapshotState().snapshot).toBeUndefined();
  } finally {
    release();
  }
});
