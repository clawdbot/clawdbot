// Preserve module setup before modules that consume it.
// oxfmt-ignore
import {
  getPreparedModelRuntimeMocks,
  resetPreparedModelRuntimeHarness,
} from "../agents/prepared-model-runtime.test-harness.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { revokeRuntimeAuthMaterializations } from "../agents/auth-profiles/runtime-materializations.js";
import { reportEmbeddedRunSuccessfulAuthBinding } from "../agents/embedded-agent-runner/run/auth-profile-success.js";
import type { EmbeddedRunAttemptResult } from "../agents/embedded-agent-runner/run/types.js";
import { getPreparedModelCatalogOwnerSnapshot } from "../agents/prepared-model-catalog.js";
import { getPreparedModelRuntimeAuthMaterializations } from "../agents/prepared-model-runtime-auth.js";
import { refreshPreparedModelRuntimeSnapshots } from "../agents/prepared-model-runtime.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createGatewayChatMetadataLifecycle } from "./server-chat-metadata-lifecycle.js";
import {
  buildModelsListResult,
  createGatewayAgentModelCatalogProjector,
} from "./server-methods/models-list-result.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import { registerGatewayModelCatalogPrivateAccess } from "./server-model-catalog-auth.js";
import {
  loadGatewayModelCatalogSnapshot,
  loadPreparedGatewayModelCatalogSnapshot,
  readPreparedGatewayModelCatalogOwnerSnapshot,
} from "./server-model-catalog.js";
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
  vi.stubEnv("OPENAI_API_KEY", "");
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

function configureAuthFixture(kind: "secret-ref" | "external-oauth" | "unresolved-secret-ref") {
  if (kind === "external-oauth") {
    return;
  }
  const apiKeyModel = { ...model, api: "openai-responses" as const };
  mocks.buildPreparedModelCatalogSnapshot.mockResolvedValue({
    entries: [apiKeyModel],
    routeVariants: [apiKeyModel],
  });
  mocks.authStorage.getAll.mockReturnValue({
    openai: { type: "api_key", key: "openclaw-secret-ref-configured" },
  });
  mocks.preparedAuthStore = {
    version: 1,
    profiles: {
      "openai:default": {
        type: "api_key",
        provider: "openai",
        keyRef: { source: "file", provider: "round4-file", id: "value" },
        ...(kind === "secret-ref" ? { key: "resolved-at-runtime" } : {}),
      },
    },
  };
}

function configureHarnessOwnedUnresolvedAuth() {
  mocks.authStorage.getAll.mockReturnValue({
    openai: { type: "api_key", key: "openclaw-secret-ref-configured" },
  });
  mocks.preparedAuthStore = {
    version: 1,
    profiles: {
      "openai:default": {
        type: "api_key",
        provider: "openai",
        keyRef: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
      },
    },
  };
}

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const sidecar of sidecars) {
    await sidecar.stop();
  }
});

async function createLifecycle(getConfig: () => OpenClawConfig = () => config) {
  return await createGatewayChatMetadataLifecycle({
    getConfig,
    minimalTestGateway: false,
    log: { warn: vi.fn() } as never,
  });
}

async function publishOwner(ownerConfig: OpenClawConfig = config): Promise<void> {
  await refreshPreparedModelRuntimeSnapshots(ownerConfig, {
    gatewayLifecycle: true,
    catalogMode: "live",
    allowGatewaySubagentBinding: true,
  });
}

async function expectAvailable(
  lifecycle: Awaited<ReturnType<typeof createGatewayChatMetadataLifecycle>>,
  expectedAvailable = true,
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
    preparedAuthStore: mocks.preparedAuthStore ?? { version: 1, profiles: {} },
    preparedRuntimeAuthModes: owner.authModes,
    preparedRuntimeAuthMaterializations: getPreparedModelRuntimeAuthMaterializations(owner),
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
  expect({
    chatMetadata: metadataModel?.available,
    modelsList: listedModel?.available,
  }).toEqual({
    chatMetadata: expectedAvailable,
    modelsList: expectedAvailable,
  });
}

describe("gateway chat metadata lifecycle composition", () => {
  it.each([
    ["SecretRef-only runtime auth", "secret-ref", true],
    ["external CLI OAuth bootstrap", "external-oauth", true],
    ["unresolved SecretRef", "unresolved-secret-ref", false],
  ] as const)("converges chat metadata and models.list for %s", async (_, kind, available) => {
    configureAuthFixture(kind);
    await publishOwner();
    const lifecycle = await createLifecycle();
    await lifecycle.attachContext(context, sidecars);

    await expectAvailable(lifecycle, available);
  });

  it("catches up when the prepared owner publishes before attachment", async () => {
    await publishOwner();
    const lifecycle = await createLifecycle();

    await lifecycle.attachContext(context, sidecars);

    await expectAvailable(lifecycle);
  });

  it("keeps the published owner across a display-only config publication", async () => {
    const publishedConfig = {
      ...config,
      ui: { prefs: { chatShowThinking: true } },
    } satisfies OpenClawConfig;
    const currentConfig = {
      ...config,
      ui: { prefs: { chatShowThinking: false } },
    } satisfies OpenClawConfig;
    await publishOwner(publishedConfig);
    const lifecycle = await createLifecycle(() => currentConfig);
    const loadCatalogSnapshot: GatewayRequestContext["loadGatewayModelCatalogSnapshot"] = (
      loadParams,
    ) => loadGatewayModelCatalogSnapshot({ ...loadParams, getConfig: () => currentConfig });
    registerGatewayModelCatalogPrivateAccess(loadCatalogSnapshot, {
      loadDeferred: (loadParams) =>
        loadPreparedGatewayModelCatalogSnapshot({
          ...loadParams,
          getConfig: () => currentConfig,
        }),
      readPrepared: (loadParams) =>
        readPreparedGatewayModelCatalogOwnerSnapshot({
          ...loadParams,
          getConfig: () => currentConfig,
        }),
    });
    const currentContext = {
      ...context,
      getRuntimeConfig: () => currentConfig,
      loadGatewayModelCatalogSnapshot: loadCatalogSnapshot,
    } as GatewayRequestContext;

    await lifecycle.attachContext(currentContext, sidecars);

    await expect(lifecycle.read({ agentId: "main" })).resolves.toMatchObject({
      models: [
        expect.objectContaining({
          available: true,
          id: "gpt-5.4",
          provider: "openai",
        }),
      ],
    });
  });

  it("publishes a successful harness auth binding before the next metadata read", async () => {
    configureHarnessOwnedUnresolvedAuth();
    await publishOwner();
    const lifecycle = await createLifecycle();
    await lifecycle.attachContext(context, sidecars);
    await expectAvailable(lifecycle, false);
    const profileStore = mocks.preparedAuthStore;
    if (!profileStore) {
      throw new Error("expected unresolved prepared auth store");
    }

    reportEmbeddedRunSuccessfulAuthBinding({
      profileStore,
      apiKeyInfo: null,
      attempt: {
        runtimeArtifact: {
          id: "codex-app-server:test",
          fingerprint: "codex-runtime-fingerprint",
        },
      } as EmbeddedRunAttemptResult,
      provider: "openai",
      agentDir: "/tmp/configured-main",
      modelId: "gpt-5.4",
      modelApi: "openai-chatgpt-responses",
      modelBaseUrl: "https://chatgpt.com/backend-api/codex",
      requestTransportOverrides: "none",
      config,
      agentHarnessId: "codex",
      pluginHarnessOwnsTransport: true,
      pluginHarnessOwnsAuthBootstrap: true,
    });

    expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledOnce();
    expect(mocks.preparedAuthMaterializations).toEqual([
      expect.objectContaining({
        provider: "openai",
        modelId: "gpt-5.4",
        modelApi: "openai-chatgpt-responses",
        modelBaseUrl: "https://chatgpt.com/backend-api/codex",
        requestTransportOverrides: "none",
        authMode: "oauth",
        runtimeOwnerId: "codex",
      }),
    ]);

    await vi.waitFor(async () => await expectAvailable(lifecycle));

    revokeRuntimeAuthMaterializations({
      agentDir: "/tmp/configured-main",
      provider: "openai",
      runtimeOwnerId: "codex",
    });
    await vi.waitFor(async () => await expectAvailable(lifecycle, false));
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
