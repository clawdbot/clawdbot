// Plugin snapshot cold-import tests keep metadata inventory off the mutable runtime registry.
import { afterEach, describe, expect, it, vi } from "vitest";

describe("status-snapshot cold imports", () => {
  afterEach(() => {
    vi.doUnmock("./registry.js");
    vi.resetModules();
  });

  it("does not import the mutable plugin registry barrel", async () => {
    vi.resetModules();
    vi.doMock("./registry.js", () => {
      throw new Error("plugin status snapshots must use the lightweight registry owner");
    });

    const module = await import("./status-snapshot.js");

    expect(module.buildPluginRegistrySnapshotReport).toBeTypeOf("function");
  });
});
