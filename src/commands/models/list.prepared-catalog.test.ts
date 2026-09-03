import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  buildModelsListResult: vi.fn(),
  loadPreparedGatewayModelCatalogSnapshot: vi.fn(),
  loadModelsConfigWithSource: vi.fn(),
  printModelTable: vi.fn(),
  resolveModelsTargetAgent: vi.fn(),
}));

vi.mock("./load-config.js", () => ({
  loadModelsConfigWithSource: mocks.loadModelsConfigWithSource,
}));

vi.mock("../../gateway/server-model-catalog.js", () => ({
  loadPreparedGatewayModelCatalogSnapshot: mocks.loadPreparedGatewayModelCatalogSnapshot,
}));

vi.mock("../../gateway/server-methods/models-list-result.js", () => ({
  buildModelsListResult: mocks.buildModelsListResult,
}));

vi.mock("./list.table.js", () => ({
  printModelTable: mocks.printModelTable,
}));

vi.mock("./shared.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./shared.js")>()),
  resolveModelsTargetAgent: mocks.resolveModelsTargetAgent,
}));

import { modelsListCommand } from "./list.list-command.js";

const config = {
  agents: { defaults: { model: { primary: "anthropic/claude-sonnet-5" } } },
};

const preparedCatalog = {
  agentId: "main",
  agentDir: "/tmp/openclaw-agent",
  workspaceDir: "/tmp/openclaw-workspace",
  config,
  providerAuth: {},
  authStore: { version: 1, profiles: {} },
  metadataSnapshot: {
    manifestRegistry: { plugins: [] },
    owners: { providers: new Map(), modelCatalogProviders: new Map() },
  },
  authMaterializations: [],
  entries: [
    {
      provider: "anthropic",
      id: "claude-sonnet-5",
      name: "Claude Sonnet 5",
      baseUrl: "https://api.anthropic.com",
      input: ["text"],
      contextWindow: 200_000,
    },
  ],
  routeVariants: [],
};

const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.loadModelsConfigWithSource.mockResolvedValue({ resolvedConfig: config });
  mocks.resolveModelsTargetAgent.mockReturnValue({
    agentId: "main",
    agentDir: preparedCatalog.agentDir,
  });
  mocks.loadPreparedGatewayModelCatalogSnapshot.mockResolvedValue(preparedCatalog);
  mocks.buildModelsListResult.mockResolvedValue({
    models: [
      {
        provider: "anthropic",
        id: "claude-sonnet-5",
        name: "Claude Sonnet 5",
        input: ["text"],
        contextWindow: 200_000,
        available: true,
      },
    ],
  });
});

describe("models list prepared catalog boundary", () => {
  it("renders the public prepared owner projection and never assembles a CLI catalog", async () => {
    await modelsListCommand({ all: true, json: true }, runtime);

    expect(mocks.loadPreparedGatewayModelCatalogSnapshot).toHaveBeenCalledWith({
      agentId: "main",
      agentDir: "/tmp/openclaw-agent",
      getConfig: expect.any(Function),
      readOnly: false,
      refreshFullCatalog: true,
    });
    expect(mocks.buildModelsListResult).toHaveBeenCalledWith({
      agentId: "main",
      preparedCatalog,
      params: { view: "all" },
    });
    expect(mocks.printModelTable).toHaveBeenCalledWith(
      [expect.objectContaining({ key: "anthropic/claude-sonnet-5", available: true })],
      runtime,
      { all: true, json: true },
    );
    expect(mocks.printModelTable.mock.calls[0]?.[0]).not.toContainEqual(
      expect.objectContaining({ key: expect.stringMatching(/^claude-cli\//u) }),
    );
  });
});
