import { vi } from "vitest";

const resolveProviderUsageSnapshotWithPluginMock = vi.hoisted(() =>
  vi.fn<typeof import("../plugins/provider-runtime.js").resolveProviderUsageSnapshotWithPlugin>(
    async () => null,
  ),
);

vi.mock("../config/config.js", () => ({
  loadConfig: () => ({}),
}));

vi.mock("../plugins/provider-runtime.js", async () => {
  const actual = await vi.importActual<typeof import("../plugins/provider-runtime.js")>(
    "../plugins/provider-runtime.js",
  );
  return {
    ...actual,
    resolveProviderUsageSnapshotWithPlugin: resolveProviderUsageSnapshotWithPluginMock,
  };
});

export function resetProviderUsageSnapshotWithPluginMock() {
  resolveProviderUsageSnapshotWithPluginMock.mockReset();
  resolveProviderUsageSnapshotWithPluginMock.mockResolvedValue(null);
}

export function getProviderUsageSnapshotWithPluginMock() {
  return resolveProviderUsageSnapshotWithPluginMock;
}
