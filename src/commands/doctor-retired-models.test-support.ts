import { afterEach, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";

const retirementRules = vi.hoisted(() =>
  [
    "gpt-5.4",
    "retired-with-successor",
    "retired-without-successor",
    "retired-with-slash",
    "retired-global-without-successor",
    "retired-api-conditioned",
  ].map((model) => ({
    provider: "openai",
    model,
    when:
      model === "retired-global-without-successor"
        ? undefined
        : {
            baseUrlHosts: ["chatgpt.com"],
            ...(model === "retired-api-conditioned"
              ? { providerConfigApiIn: ["openai-chatgpt-responses"] }
              : {}),
          },
    retirement: model.includes("without-successor")
      ? {}
      : {
          replacedBy: model === "retired-with-slash" ? "family/current-model" : "current-model",
        },
  })),
);

vi.mock("../plugins/manifest-contract-eligibility.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../plugins/manifest-contract-eligibility.js")>();
  return {
    ...actual,
    loadManifestMetadataSnapshot: (
      ...args: Parameters<typeof actual.loadManifestMetadataSnapshot>
    ) => {
      const snapshot = actual.loadManifestMetadataSnapshot(...args);
      const plugins = snapshot.plugins.slice();
      for (const [index, plugin] of snapshot.plugins.entries()) {
        if (plugin.id === "openai") {
          plugins[index] = {
            ...plugin,
            modelCatalog: { ...plugin.modelCatalog, suppressions: retirementRules },
          };
        }
      }
      return {
        ...snapshot,
        plugins,
      };
    },
  };
});

vi.mock("../agents/openai-model-routes.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../agents/openai-model-routes.js")>();
  return {
    ...actual,
    createOpenAIModelRoutesResolver: () => () => ({
      kind: "routes",
      defaultRuntimeId: "codex",
      routes: [
        {
          api: "openai-responses",
          baseUrl: "https://api.openai.com/v1",
          authRequirement: "api-key",
          requestTransportOverrides: "none",
          runtimePolicy: { compatibleIds: ["openclaw", "codex"] },
        },
        {
          api: "openai-chatgpt-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          authRequirement: "subscription",
          requestTransportOverrides: "none",
          runtimePolicy: { compatibleIds: ["openclaw", "codex"] },
        },
      ],
    }),
  };
});

const states: OpenClawTestState[] = [];
afterEach(async () => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  for (const state of states.splice(0)) {
    await state.cleanup();
  }
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

export async function createRetiredModelFixture(auth: "oauth" | "api-key" = "oauth") {
  const state = await createOpenClawTestState({
    layout: "state-only",
    prefix: "doctor-retired-model-",
  });
  states.push(state);
  state.applyEnv();
  vi.stubEnv("OPENAI_API_KEY", undefined);
  await state.writeAuthProfiles({
    version: 1,
    profiles: {
      chatgpt: {
        provider: "openai",
        type: "oauth",
        access: "synthetic-access",
        refresh: "synthetic-refresh",
        expires: 9_999_999_999_999,
      },
      platform: { provider: "openai", type: "api_key", key: "synthetic-key" },
    },
  });
  const cfg: OpenClawConfig = {
    agents: { entries: { main: {} }, defaults: { model: "openai/current-model" } },
    auth: { order: { openai: [auth === "oauth" ? "chatgpt" : "platform"] } },
    models: { providers: { openai: { baseUrl: "https://api.openai.com/v1", models: [] } } },
  };
  return { state, cfg };
}
