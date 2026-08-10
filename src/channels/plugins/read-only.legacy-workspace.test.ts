import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { retainLegacyDefaultAgentId } from "../../config/legacy.default-agent-owner.js";
import { clearPluginMetadataLifecycleCaches } from "../../plugins/plugin-metadata-lifecycle.js";
import { resetPluginRuntimeStateForTest } from "../../plugins/runtime.js";
import { resolveReadOnlyChannelPluginsForConfig } from "./read-only.js";

const mocks = vi.hoisted(() => ({
  resolvePluginMetadataSnapshot: vi.fn(() => ({ plugins: [] })),
}));

vi.mock("../../plugins/plugin-metadata-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/plugin-metadata-snapshot.js")>()),
  resolvePluginMetadataSnapshot: mocks.resolvePluginMetadataSnapshot,
}));

afterEach(() => {
  mocks.resolvePluginMetadataSnapshot.mockClear();
  clearPluginMetadataLifecycleCaches();
  resetPluginRuntimeStateForTest();
});

describe("read-only channel plugin legacy workspace discovery", () => {
  it("scans the retained compatibility owner's explicit workspace", () => {
    const cfg = retainLegacyDefaultAgentId(
      {
        agents: {
          ownership: "explicit",
          entries: {
            research: {},
            ops: { workspace: "/srv/ops" },
          },
        },
      },
      "ops",
    );

    resolveReadOnlyChannelPluginsForConfig(cfg, {
      env: { ...process.env },
      includePersistedAuthState: false,
    });

    expect(mocks.resolvePluginMetadataSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        config: cfg,
        workspaceDir: path.resolve("/srv/ops"),
      }),
    );
  });
});
