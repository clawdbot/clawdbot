import { expect, it, vi } from "vitest";

const metadata = vi.hoisted(() => vi.fn());

vi.mock("./plugin-metadata-snapshot.js", () => ({
  loadPluginMetadataSnapshot: (...args: unknown[]) => metadata(...args),
  resolvePluginMetadataSnapshot: (...args: unknown[]) => metadata(...args),
}));

const { listManagedPlugins } = await import("./management-service.js");

it("loads plugin metadata from the explicit system-owner workspace", async () => {
  const config = {
    agents: {
      ownership: "explicit" as const,
      defaults: { systemAgent: { agentId: "research" } },
      entries: { main: {}, research: { workspace: "~/research-workspace" } },
    },
  };
  const env = { HOME: "/tmp/openclaw-managed-plugin-home" };
  metadata.mockReturnValue({
    index: { plugins: [], installRecords: {} },
    byPluginId: new Map(),
    diagnostics: [],
    normalizePluginId: (pluginId: string) => pluginId,
  });

  await listManagedPlugins({ config, env, officialCatalog: { entries: [] } });

  expect(metadata).toHaveBeenCalledWith({
    config,
    env,
    workspaceDir: "/tmp/openclaw-managed-plugin-home/research-workspace",
  });
});
