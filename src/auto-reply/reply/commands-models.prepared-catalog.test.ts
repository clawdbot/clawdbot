import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { buildModelsProviderData } from "./commands-models.js";

const catalogMocks = vi.hoisted(() => ({
  isFull: vi.fn(),
  load: vi.fn(),
}));

vi.mock("../../agents/cli-backends.js", () => ({
  listCliRuntimeModelBackendBindings: () => [],
}));

vi.mock("../../agents/prepared-model-catalog.js", () => ({
  loadPreparedModelCatalogSnapshot: catalogMocks.load,
}));

vi.mock("../../agents/prepared-model-runtime.facts.js", () => ({
  isPreparedModelCatalogFull: catalogMocks.isFull,
}));

vi.mock("../../agents/model-provider-auth.js", () => ({
  createProviderAuthChecker: () =>
    Object.assign(
      vi.fn(() => true),
      {
        evaluateModelAuth: vi.fn(async () => ({ availability: true, routeResolution: null })),
      },
    ),
}));

const config = {
  agents: {
    defaults: {
      model: { primary: "openai/prepared-model" },
      modelPolicy: { allow: ["openai/*"] },
    },
  },
} satisfies OpenClawConfig;

describe("buildModelsProviderData prepared catalog", () => {
  beforeEach(() => {
    catalogMocks.isFull.mockReset();
    catalogMocks.load.mockReset();
    catalogMocks.load.mockResolvedValue({
      entries: [{ provider: "openai", id: "prepared-model", name: "Prepared Model" }],
      routeVariants: [],
    });
  });

  it.each([
    { complete: true, reads: [true] },
    { complete: false, reads: [true, false] },
  ])("uses the prepared catalog before wildcard browse (complete: $complete)", async (testCase) => {
    catalogMocks.isFull.mockReturnValueOnce(testCase.complete);

    await buildModelsProviderData(config);

    expect(catalogMocks.load.mock.calls.map(([params]) => params.readOnly)).toEqual(testCase.reads);
  });
});
