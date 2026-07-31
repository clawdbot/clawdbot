import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getCurrentPluginMetadataSnapshotState,
  setCurrentPluginMetadataSnapshotState,
} from "./current-plugin-metadata-state.js";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";
import "./plugin-registry-snapshot.js";

vi.mock("./current-plugin-metadata-snapshot.js", () => ({
  getCurrentPluginMetadataSnapshot: vi.fn(() => undefined),
}));

afterEach(() => {
  clearPluginMetadataLifecycleCaches();
});

describe("plugin registry snapshot lifecycle", () => {
  it("clears registry metadata when the snapshot facade is mocked", () => {
    setCurrentPluginMetadataSnapshotState({ plugins: [] }, "mocked-snapshot-facade");

    expect(() => clearPluginMetadataLifecycleCaches()).not.toThrow();
    expect(getCurrentPluginMetadataSnapshotState().snapshot).toBeUndefined();
  });
});
