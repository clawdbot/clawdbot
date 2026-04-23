import { describe, expect, it, vi } from "vitest";
import type { AuthProfileStore } from "../../agents/auth-profiles/types.js";
import type { ModelRow } from "./list.types.js";

const mocks = vi.hoisted(() => ({
  shouldSuppressBuiltInModel: vi.fn(() => {
    throw new Error("runtime model suppression should be skipped");
  }),
  loadProviderCatalogModelsForList: vi.fn().mockResolvedValue([
    {
      id: "gpt-5.5",
      name: "gpt-5.5",
      provider: "codex",
      api: "openai-codex-responses",
      baseUrl: "https://chatgpt.com/backend-api",
      input: ["text"],
    },
  ]),
  listProfilesForProvider: vi.fn().mockReturnValue(["codex:synthetic"]),
}));

vi.mock("../../agents/model-suppression.js", () => ({
  shouldSuppressBuiltInModel: mocks.shouldSuppressBuiltInModel,
}));

vi.mock("./list.runtime.js", () => ({
  loadProviderCatalogModelsForList: mocks.loadProviderCatalogModelsForList,
  listProfilesForProvider: mocks.listProfilesForProvider,
  resolveAwsSdkEnvVarName: vi.fn().mockReturnValue(undefined),
  resolveEnvApiKey: vi.fn().mockReturnValue(null),
  hasUsableCustomProviderApiKey: vi.fn().mockReturnValue(false),
}));

vi.mock("../../plugins/synthetic-auth.runtime.js", () => ({
  resolveRuntimeSyntheticAuthProviderRefs: vi.fn().mockReturnValue([]),
}));

import { appendProviderCatalogRows } from "./list.rows.js";

describe("appendProviderCatalogRows", () => {
  it("can skip runtime model-suppression hooks for provider-catalog fast paths", async () => {
    const rows: ModelRow[] = [];
    const authStore: AuthProfileStore = {
      version: 1,
      profiles: {
        "codex:synthetic": {
          type: "token",
          provider: "codex",
          token: "codex-app-server",
        },
      },
      order: {},
    };

    await appendProviderCatalogRows({
      rows,
      seenKeys: new Set(),
      context: {
        cfg: {
          agents: { defaults: { model: { primary: "codex/gpt-5.5" } } },
          models: { providers: {} },
        },
        agentDir: "/tmp/openclaw-agent",
        authStore,
        configuredByKey: new Map(),
        discoveredKeys: new Set(),
        filter: { provider: "codex", local: false },
        skipRuntimeModelSuppression: true,
      },
    });

    expect(mocks.shouldSuppressBuiltInModel).not.toHaveBeenCalled();
    expect(rows).toMatchObject([
      {
        key: "codex/gpt-5.5",
        available: true,
        missing: false,
      },
    ]);
  });
});
