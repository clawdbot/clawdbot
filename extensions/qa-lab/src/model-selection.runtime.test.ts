import { beforeEach, describe, expect, it, vi } from "vitest";

const { resolveEnvApiKey, loadAuthProfileStoreForRuntime, listProfilesForProvider } = vi.hoisted(
  () => ({
    resolveEnvApiKey: vi.fn(),
    loadAuthProfileStoreForRuntime: vi.fn(),
    listProfilesForProvider: vi.fn(),
  }),
);

vi.mock("openclaw/plugin-sdk/provider-auth", () => ({
  resolveEnvApiKey,
}));

vi.mock("openclaw/plugin-sdk/agent-runtime", () => ({
  loadAuthProfileStoreForRuntime,
  listProfilesForProvider,
}));

import {
  defaultQaRuntimeModelForMode,
  resolveQaPreferredLiveModel,
} from "./model-selection.runtime.js";

describe("qa model selection runtime", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveEnvApiKey.mockReturnValue(undefined);
    loadAuthProfileStoreForRuntime.mockReturnValue({ profiles: {} });
    listProfilesForProvider.mockImplementation((store: { profiles?: Record<string, unknown> }) =>
      Object.keys(store.profiles ?? {}),
    );
  });

  it("keeps the OpenAI live default when an API key is configured", () => {
    resolveEnvApiKey.mockReturnValue({ apiKey: "sk-test" });

    expect(resolveQaPreferredLiveModel()).toBeUndefined();
    expect(defaultQaRuntimeModelForMode("live-frontier")).toBe("openai/gpt-5.5");
    expect(loadAuthProfileStoreForRuntime).not.toHaveBeenCalled();
  });

  it("prefers the Codex OAuth live default when only Codex auth profiles are available", () => {
    loadAuthProfileStoreForRuntime.mockReturnValue({
      profiles: {
        "openai:user@example.com": {
          provider: "openai",
          type: "oauth",
        },
      },
    });

    expect(resolveQaPreferredLiveModel()).toBe("openai/gpt-5.5");
    expect(defaultQaRuntimeModelForMode("live-frontier")).toBe("openai/gpt-5.5");
    expect(loadAuthProfileStoreForRuntime).toHaveBeenCalledWith(undefined, {
      readOnly: true,
      allowKeychainPrompt: false,
      externalCliProviderIds: ["openai"],
    });
  });

  it("keeps the OpenAI live default when stored OpenAI profiles are available", () => {
    loadAuthProfileStoreForRuntime.mockReturnValue({
      profiles: {
        "openai:api-key": {
          provider: "openai",
          type: "api_key",
        },
      },
    });

    expect(resolveQaPreferredLiveModel()).toBeUndefined();
    expect(defaultQaRuntimeModelForMode("live-frontier")).toBe("openai/gpt-5.5");
  });

  it("leaves mock defaults unchanged", () => {
    expect(defaultQaRuntimeModelForMode("mock-openai")).toBe("mock-openai/gpt-5.5");
    expect(defaultQaRuntimeModelForMode("mock-openai", { alternate: true })).toBe(
      "mock-openai/gpt-5.5-alt",
    );
    expect(defaultQaRuntimeModelForMode("aimock")).toBe("aimock/gpt-5.5");
    expect(defaultQaRuntimeModelForMode("aimock", { alternate: true })).toBe("aimock/gpt-5.5-alt");
  });
});
