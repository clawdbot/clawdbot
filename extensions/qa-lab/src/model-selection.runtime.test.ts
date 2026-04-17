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
    listProfilesForProvider.mockReturnValue([]);
  });

  it("keeps the OpenAI live default when an API key is configured", () => {
    resolveEnvApiKey.mockReturnValue({ apiKey: "sk-test" });

    expect(resolveQaPreferredLiveModel()).toBeUndefined();
    expect(defaultQaRuntimeModelForMode("live-frontier")).toBe("openai/gpt-5.4");
    expect(loadAuthProfileStoreForRuntime).not.toHaveBeenCalled();
  });

  it("prefers the Codex OAuth live default when only Codex auth profiles are available", () => {
    listProfilesForProvider.mockImplementation((_store: unknown, provider: string) =>
      provider === "openai-codex" ? ["openai-codex:user@example.com"] : [],
    );

    expect(resolveQaPreferredLiveModel()).toBe("openai-codex/gpt-5.4");
    expect(defaultQaRuntimeModelForMode("live-frontier")).toBe("openai-codex/gpt-5.4");
  });

  it("keeps the OpenAI live default when stored OpenAI profiles are available", () => {
    listProfilesForProvider.mockImplementation((_store: unknown, provider: string) =>
      provider === "openai" || provider === "openai-codex" ? [`${provider}:user@example.com`] : [],
    );

    expect(resolveQaPreferredLiveModel()).toBeUndefined();
    expect(defaultQaRuntimeModelForMode("live-frontier")).toBe("openai/gpt-5.4");
  });

  it("leaves mock defaults unchanged", () => {
    listProfilesForProvider.mockImplementation((_store: unknown, provider: string) =>
      provider === "openai-codex" ? ["openai-codex:user@example.com"] : [],
    );

    expect(defaultQaRuntimeModelForMode("mock-openai")).toBe("mock-openai/gpt-5.4");
    expect(defaultQaRuntimeModelForMode("mock-openai", { alternate: true })).toBe(
      "mock-openai/gpt-5.4-alt",
    );
    expect(defaultQaRuntimeModelForMode("aimock")).toBe("aimock/gpt-5.4");
    expect(defaultQaRuntimeModelForMode("aimock", { alternate: true })).toBe("aimock/gpt-5.4-alt");
  });
});
