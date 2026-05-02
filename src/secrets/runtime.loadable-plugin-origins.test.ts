import { afterEach, describe, expect, it, vi } from "vitest";
import { asConfig, setupSecretsRuntimeSnapshotTestHooks } from "./runtime.test-support.ts";

const manifestMocks = vi.hoisted(() => ({
  listPluginOriginsFromMetadataSnapshot: vi.fn(
    (snapshot: { plugins: Array<{ id: string; origin: string }> }) =>
      new Map(snapshot.plugins.map((record) => [record.id, record.origin])),
  ),
  loadPluginMetadataSnapshot: vi.fn<() => { plugins: Array<{ id: string; origin: string }> }>(
    () => ({
      plugins: [],
    }),
  ),
}));

vi.mock("./runtime-manifest.runtime.js", () => ({
  listPluginOriginsFromMetadataSnapshot: manifestMocks.listPluginOriginsFromMetadataSnapshot,
  loadPluginMetadataSnapshot: manifestMocks.loadPluginMetadataSnapshot,
}));

const { prepareSecretsRuntimeSnapshot } = setupSecretsRuntimeSnapshotTestHooks();

describe("prepareSecretsRuntimeSnapshot loadable plugin origins", () => {
  afterEach(() => {
    manifestMocks.listPluginOriginsFromMetadataSnapshot.mockClear();
    manifestMocks.loadPluginMetadataSnapshot.mockReset();
    manifestMocks.loadPluginMetadataSnapshot.mockReturnValue({ plugins: [] });
  });

  it("skips metadata snapshot loading when plugin entries are absent", async () => {
    await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        models: {
          providers: {
            openai: {
              apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
              models: [{ id: "gpt-5.4", name: "gpt-5.4" }],
            },
          },
        },
      }),
      env: { OPENAI_API_KEY: "sk-test" },
      includeAuthStoreRefs: false,
    });

    expect(manifestMocks.loadPluginMetadataSnapshot).not.toHaveBeenCalled();
    expect(manifestMocks.listPluginOriginsFromMetadataSnapshot).not.toHaveBeenCalled();
  });

  it("derives loadable plugin origins from the shared metadata snapshot", async () => {
    const snapshot = {
      plugins: [{ id: "demo", origin: "workspace" }],
    };
    manifestMocks.loadPluginMetadataSnapshot.mockReturnValue(snapshot);

    await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        plugins: {
          entries: {
            demo: {
              config: {
                apiKey: { source: "env", provider: "default", id: "DEMO_API_KEY" },
              },
            },
          },
        },
      }),
      env: { HOME: "/home/demo", DEMO_API_KEY: "sk-demo" },
      includeAuthStoreRefs: false,
    });

    expect(manifestMocks.loadPluginMetadataSnapshot).toHaveBeenCalledWith({
      config: expect.objectContaining({
        plugins: expect.any(Object),
      }),
      workspaceDir: expect.any(String),
      env: expect.objectContaining({
        HOME: "/home/demo",
        DEMO_API_KEY: "sk-demo",
      }),
    });
    expect(manifestMocks.listPluginOriginsFromMetadataSnapshot).toHaveBeenCalledWith(snapshot);
  });
});
