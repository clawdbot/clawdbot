import "../agents/prepared-model-runtime.test-harness.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getPreparedModelCatalogOwnerSnapshot } from "../agents/prepared-model-catalog.js";
import { refreshPreparedModelRuntimeSnapshots } from "../agents/prepared-model-runtime.js";
import {
  getPreparedModelRuntimeMocks,
  resetPreparedModelRuntimeHarness,
} from "../agents/prepared-model-runtime.test-harness.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createGatewayChatMetadataLifecycle } from "./server-chat-metadata-lifecycle.js";
import {
  buildModelsListResult,
  createGatewayAgentModelCatalogProjector,
} from "./server-methods/models-list-result.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import type { GatewayPostReadySidecarHandle } from "./server-startup-post-attach.js";

const mocks = getPreparedModelRuntimeMocks();
const config = {
  agents: {
    defaults: {
      model: { primary: "openai/gpt-5.4" },
      models: { "openai/gpt-5.4": {} },
      modelPolicy: { allow: ["openai/gpt-5.4"] },
    },
    list: [{ id: "main", default: true }],
  },
} as OpenClawConfig;
const model = {
  id: "gpt-5.4",
  name: "GPT-5.4",
  provider: "openai",
  api: "openai-chatgpt-responses" as const,
};
const context = {
  getRuntimeConfig: () => config,
  logGateway: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
} as unknown as GatewayRequestContext;
let sidecars: GatewayPostReadySidecarHandle[] = [];

beforeEach(() => {
  resetPreparedModelRuntimeHarness();
  mocks.configuredAgentIds = ["main"];
  mocks.authStorage.getAll.mockReturnValue({
    openai: {
      type: "oauth",
      access: "prepared-access",
      refresh: "prepared-refresh",
      expires: Date.now() + 30 * 60_000,
    },
  });
  mocks.buildPreparedModelCatalogSnapshot.mockResolvedValue({
    entries: [model],
    routeVariants: [model],
  });
  sidecars = [];
});

afterEach(async () => {
  for (const sidecar of sidecars) {
    await sidecar.stop();
  }
});

async function createLifecycle() {
  return await createGatewayChatMetadataLifecycle({
    getConfig: () => config,
    minimalTestGateway: false,
    log: { warn: vi.fn() } as never,
  });
}

async function publishOwner(): Promise<void> {
  await refreshPreparedModelRuntimeSnapshots(config, {
    gatewayLifecycle: true,
    catalogMode: "static",
    allowGatewaySubagentBinding: true,
  });
}

async function expectAvailable(
  lifecycle: Awaited<ReturnType<typeof createGatewayChatMetadataLifecycle>>,
): Promise<void> {
  const owner = getPreparedModelCatalogOwnerSnapshot({
    agentId: "main",
    config,
    readOnly: true,
    allowGatewaySubagentBinding: true,
  });
  if (!owner) {
    throw new Error("expected prepared model owner");
  }
  const projector = createGatewayAgentModelCatalogProjector({
    cfg: config,
    agentId: "main",
    snapshot: owner.modelCatalog,
    metadataSnapshot: owner.metadataSnapshot,
    preparedAuthStore: { version: 1, profiles: {} },
    preparedRuntimeAuthModes: owner.authModes,
  });
  const [metadata, modelsList] = await Promise.all([
    lifecycle.read({ agentId: "main" }),
    buildModelsListResult({
      context,
      agentId: "main",
      params: { view: "configured" },
      preloadedCatalog: {
        agentId: "main",
        config,
        snapshot: owner.modelCatalog,
      },
      preloadedOnly: true,
      catalogProjector: projector,
    }),
  ]);
  const metadataModels = metadata.models as
    | Array<{ id?: string; provider?: string; available?: boolean }>
    | undefined;
  const metadataModel = metadataModels?.find(
    (candidate) => candidate.id === "gpt-5.4" && candidate.provider === "openai",
  );
  const listedModel = modelsList.models.find(
    (candidate) => candidate.id === "gpt-5.4" && candidate.provider === "openai",
  );
  expect(metadataModel?.available).toBe(listedModel?.available);
  expect(listedModel?.available).toBe(true);
}

describe("gateway chat metadata lifecycle composition", () => {
  it("catches up when the prepared owner publishes before attachment", async () => {
    await publishOwner();
    const lifecycle = await createLifecycle();

    await lifecycle.attachContext(context, sidecars);

    await expectAvailable(lifecycle);
  });

  it("recovers a failed catch-up when the prepared owner publishes after attachment", async () => {
    const lifecycle = await createLifecycle();
    await lifecycle.attachContext(context, sidecars);
    await expect(lifecycle.read({ agentId: "main" })).rejects.toThrow(
      'prepared chat metadata owner is unavailable for agent "main"',
    );

    await publishOwner();

    await vi.waitFor(async () => await expectAvailable(lifecycle));
  });
});
