import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { Model } from "../../llm/types.js";
import type { AuthProfileStore } from "../auth-profiles/types.js";
import { GCP_VERTEX_CREDENTIALS_MARKER } from "../model-auth-markers.js";
import { prepareAgentRuntimeAuth } from "./prepare-auth.js";
import {
  resolvePreparedRuntimeAuthAttempts,
  resolvePreparedRuntimeModelAuth,
} from "./resolve-auth.js";

const authLookupMocks = vi.hoisted(() => ({
  resolveProviderEnvAuthLookupMaps: vi.fn(() => ({
    aliasMap: {},
    envCandidateMap: {},
    authEvidenceMap: {},
    setupProviderFallbackRefs: ["anthropic-vertex"],
  })),
}));

const setupRegistryMocks = vi.hoisted(() => ({
  resolvePluginSetupProvider: vi.fn(() => ({
    resolveConfigApiKey: () => "gcp-vertex-credentials",
  })),
}));

vi.mock("../model-auth-env-vars.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../model-auth-env-vars.js")>()),
  resolveProviderEnvAuthLookupMaps: authLookupMocks.resolveProviderEnvAuthLookupMaps,
}));

vi.mock("../../plugins/setup-registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/setup-registry.js")>()),
  resolvePluginSetupProvider: setupRegistryMocks.resolvePluginSetupProvider,
}));

describe("prepared setup-provider auth fallback", () => {
  it("defers setup resolution until a prepared profile attempt fails", async () => {
    const profileId = "anthropic-vertex:missing";
    const config = {
      auth: { order: { "anthropic-vertex": [profileId] } },
    } as OpenClawConfig;
    const store = {
      version: 1,
      profiles: {
        [profileId]: {
          type: "api_key",
          provider: "anthropic-vertex",
          keyRef: {
            source: "env",
            provider: "default",
            id: "OPENCLAW_TEST_MISSING_VERTEX_KEY",
          },
        },
      },
      order: { "anthropic-vertex": [profileId] },
    } satisfies AuthProfileStore;
    const prepared = prepareAgentRuntimeAuth({
      provider: "anthropic-vertex",
      modelId: "claude-sonnet-4-6",
      config,
      env: {},
      authProfileStore: store,
    });

    expect(setupRegistryMocks.resolvePluginSetupProvider).not.toHaveBeenCalled();
    expect(prepared.attempts).toMatchObject([
      { kind: "profile", profileId },
      {
        kind: "direct",
        allowAuthProfileFallback: false,
        requiresPriorProfileAttempt: true,
      },
    ]);

    const model = {
      id: "claude-sonnet-4-6",
      name: "Claude Sonnet 4.6",
      provider: "anthropic-vertex",
      api: "anthropic-messages",
      baseUrl: "https://example.invalid",
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200_000,
      maxTokens: 64_000,
    } as Model;
    const resolved = await resolvePreparedRuntimeAuthAttempts({
      attempts: prepared.attempts,
      store,
      modelId: model.id,
      model,
      materializeModel: async ({ model: preparedModel }) => preparedModel,
      resolveAuth: async ({ attempt, model: preparedModel }) =>
        resolvePreparedRuntimeModelAuth({
          plan: attempt.plan,
          model: preparedModel,
          cfg: config,
          store,
        }),
      errorMessage: "prepared Anthropic Vertex auth failed",
    });

    expect(resolved.auth).toMatchObject({
      apiKey: GCP_VERTEX_CREDENTIALS_MARKER,
      source: "gcloud adc",
      mode: "api-key",
    });
    expect(setupRegistryMocks.resolvePluginSetupProvider).toHaveBeenCalledOnce();
  });
});
