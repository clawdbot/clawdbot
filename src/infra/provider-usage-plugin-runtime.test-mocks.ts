// Mocks plugin-backed provider usage runtime for tests.
import { vi } from "vitest";

const resolveProviderUsageSnapshotWithPluginMock = vi.hoisted(() =>
  vi.fn<typeof import("../plugins/provider-runtime.js").resolveProviderUsageSnapshotWithPlugin>(
    async () => null,
  ),
);
const resolveProviderUsageAuthWithPluginMock = vi.hoisted(() =>
  vi.fn<typeof import("../plugins/provider-runtime.js").resolveProviderUsageAuthWithPlugin>(
    async () => undefined,
  ),
);

vi.mock("../config/config.js", () => ({
  getRuntimeConfig: () => ({}),
}));

vi.mock("../plugins/provider-runtime.js", async () => {
  const actual = await vi.importActual<typeof import("../plugins/provider-runtime.js")>(
    "../plugins/provider-runtime.js",
  );
  return {
    ...actual,
    resolveProviderUsageAuthWithPlugin: resolveProviderUsageAuthWithPluginMock,
    resolveProviderUsageSnapshotWithPlugin: resolveProviderUsageSnapshotWithPluginMock,
  };
});

/** Resets the plugin-backed provider usage mock to the default no-snapshot behavior. */
export function resetProviderUsageSnapshotWithPluginMock() {
  resolveProviderUsageAuthWithPluginMock.mockReset();
  resolveProviderUsageAuthWithPluginMock.mockResolvedValue(undefined);
  resolveProviderUsageSnapshotWithPluginMock.mockReset();
  resolveProviderUsageSnapshotWithPluginMock.mockResolvedValue(null);
}

export function getProviderUsageSnapshotWithPluginMock() {
  return resolveProviderUsageSnapshotWithPluginMock;
}

export function getProviderUsageAuthWithPluginMock() {
  return resolveProviderUsageAuthWithPluginMock;
}
