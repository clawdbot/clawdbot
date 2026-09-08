import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { Model } from "../../../llm/types.js";
import { createPluginMetadataSnapshotFixture } from "../../../plugins/plugin-metadata.test-support.js";
import { withPluginRuntimeGenerationScope } from "../../../plugins/runtime/generation-scope.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../../test-utils/openclaw-test-state.js";
import { clearRuntimeAuthProfileStoreSnapshot, type OAuthCredential } from "../../auth-profiles.js";
import { testing as externalAuthTesting } from "../../auth-profiles/external-auth.test-support.js";
import type { AgentHarness } from "../../harness/types.js";
import * as modelRuntime from "../model.js";
import { prepareEmbeddedRunAuthPlan } from "./auth-plan.js";

const readCodexCliCredentialsCachedMock = vi.hoisted(() =>
  vi.fn<(_options?: unknown) => OAuthCredential | null>(() => null),
);

vi.mock("../../cli-credentials.js", () => ({
  readCodexCliCredentialsCached: readCodexCliCredentialsCachedMock,
  readMiniMaxCliCredentialsCached: () => null,
}));

const subscriptionModel: Model = {
  id: "gpt-5.6-luna",
  name: "Auth pin model",
  provider: "openai",
  api: "openai-chatgpt-responses",
  baseUrl: "https://chatgpt.com/backend-api/codex",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 16_000,
  maxTokens: 1_024,
};
const platformModel: Model = {
  ...subscriptionModel,
  api: "openai-responses",
  baseUrl: "https://api.openai.com/v1",
};

const openClawHarness: AgentHarness = {
  id: "openclaw",
  label: "OpenClaw fixture",
  supports: () => ({ supported: true }),
  runAttempt: async () => {
    throw new Error("Auth preparation must not execute a model turn");
  },
};

describe("embedded run auth plan provider pin", () => {
  let state: OpenClawTestState;
  let agentDir: string;

  beforeEach(async () => {
    state = await createOpenClawTestState({
      prefix: "openclaw-auth-pin-",
      env: { OPENAI_API_KEY: "platform-api-key" },
    });
    agentDir = state.agentDir();
    readCodexCliCredentialsCachedMock.mockReset().mockReturnValue({
      type: "oauth",
      provider: "openai",
      access: "codex-access-token",
      refresh: "codex-refresh-token",
      expires: Date.now() + 30 * 60_000,
    });
    externalAuthTesting.setResolveExternalAuthProfilesForTest(() => []);
  });

  afterEach(async () => {
    clearRuntimeAuthProfileStoreSnapshot(agentDir);
    externalAuthTesting.resetResolveExternalAuthProfilesForTest();
    readCodexCliCredentialsCachedMock.mockReset();
    vi.restoreAllMocks();
    await state.cleanup();
  });

  it.each([
    { pin: true, authMode: "api-key", authRequirement: "api-key", kind: "direct" },
    { pin: false, authMode: "oauth", authRequirement: "subscription", kind: "profile" },
  ])(
    "selects $authMode with ambient Codex OAuth and api-key pin=$pin",
    async ({ pin, authMode, authRequirement, kind }) => {
      const config: OpenClawConfig = {
        models: {
          providers: {
            openai: { ...(pin ? { auth: "api-key" as const } : {}), baseUrl: "", models: [] },
          },
        },
      };
      const stores = modelRuntime.createEmptyAgentDiscoveryStores();
      // Catalog discovery is peripheral; store loading, ambient overlay, auth selection,
      // and materialization of the selected transport all run through their real owners.
      vi.spyOn(modelRuntime, "resolveModelAsync").mockImplementation(
        async (_provider, _modelId, _agentDir, cfg) => ({
          ...stores,
          model:
            cfg?.models?.providers?.openai?.api === "openai-responses"
              ? platformModel
              : subscriptionModel,
        }),
      );
      let model = subscriptionModel;
      let harness = openClawHarness;
      // A prepared generation owns plugin discovery; no provider runtime is needed here.
      const prepared = await withPluginRuntimeGenerationScope(
        { metadataSnapshot: createPluginMetadataSnapshotFixture() },
        () =>
          prepareEmbeddedRunAuthPlan({
            runParams: {
              sessionId: "auth-pin-session",
              runId: "auth-pin-run",
              workspaceDir: state.workspaceDir,
              prompt: "Auth preparation only",
              timeoutMs: 5_000,
              config,
            },
            provider: "openai",
            modelId: model.id,
            model,
            agentDir,
            workspaceDir: state.workspaceDir,
            nativeModelOwned: false,
            ...stores,
            getAgentHarness: () => harness,
            setAgentHarness: (next) => {
              harness = next;
            },
            getRuntimeModel: () => model,
            getEffectiveModel: () => model,
            applyResolvedRuntimeModel: (next) => {
              model = next;
            },
            selectHarnessForPreparedAttempts: () => openClawHarness,
          }),
      );

      expect(prepared.preparedAuthAttempts[0]).toMatchObject({
        kind,
        plan: { selectedAuthMode: authMode, modelRoute: { authRequirement } },
      });
      expect(prepared.attemptAuthProfileStore.profiles["openai:default"]?.type).toBe(
        pin ? undefined : "oauth",
      );
      expect(model).toEqual(pin ? platformModel : subscriptionModel);
    },
  );
});
