import { vi } from "vitest";

// Chat-engine tests own verified-operation behavior, not provider/plugin discovery.
// Keep fixture routes ownerless so these tests do not scan the bundled plugin graph.
vi.mock("../plugins/providers.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/providers.js")>()),
  resolveOwningPluginIdsForModelRefs: vi.fn(() => []),
  resolveOwningPluginIdsForProviderRef: vi.fn(() => []),
}));
